/**
 * Pipeline / process 阶段应用服务。
 *
 * 单一职责：
 *   - processAllPending：抓取 fetchStatus='pending' 的详情页 → 关键字门控 → 聚类素材准备
 *   - repairPublishedDates：从 rawContent HTML 中提取精确发布时间，覆盖日期-only
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts` 中；B13 抽离后保留：
 *     · MAX_BATCH_SIZE=500、CONCURRENCY=5、DELAY_MS=150、FETCH_TIMEOUT_MS=30_000
 *     · 正文处理失败最多自动重试 5 次，每次间隔 2 小时
 *     · 关键字 DB 异常仅 console.error 不阻塞主流程
 *     · repair 只处理近 7 天 fetched 且有 rawContent 的文章
 */
import type { Article } from '@prisma/client';
import { db } from '@/lib/db';
import { evaluateKeywordMatch, matchIndustryTitleSignal } from '@/lib/filter';
import { fetchArticleDetail, markArticleFetchFailure } from '@/lib/detail-fetcher';
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { assertNotAborted } from '@/lib/worker-stop';
import { extractMetaPublishedAt } from '@/lib/date-utils';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';
import { recordDiscardedItem } from '@/lib/pipeline/discarded-items';
import { recordKeywordCandidates } from '@/lib/keyword-candidate-service';
import { refreshPublicPublication } from '@/lib/public-publication-service';
import { refreshArticleSearchIndex, replaceArticleKeywordHits } from '@/lib/article-search-index';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 500;
const PROCESS_CONCURRENCY = 5;
const PROCESS_DELAY_MS = 150;
const REPAIR_WINDOW_DAYS = 7;
const REPAIR_BATCH_SIZE = 20;
const PROCESS_MAX_RETRIES = 5;

/**
 * Stage 2: Fetch detail pages for all articles with fetchStatus='pending'.
 * Updates fetchStatus='fetched' after a successful fetch with meaningful cleaned text.
 */
export async function processAllPending(signal?: AbortSignal, jobId?: string, forceRetry = false): Promise<{ total: number; processed: number; errors: number; capped: boolean }> {
  assertNotAborted(signal);

  // 重置"已抓取但正文为空"的文章，让它们重新进详情页流程。
  await db.article.updateMany({
    where: { cleanContent: '', fetchStatus: 'fetched', technicalIgnoredAt: null },
    data: { fetchStatus: 'pending', fetchError: null },
  });

  // 只恢复仍在自动重试额度内、且退避已到期的失败文章。
  // 达到上限的文章保留 failed 终态，等待人工重试或忽略。
  await db.article.updateMany({
    where: {
      fetchStatus: 'failed',
      fetchRetryCount: { lt: PROCESS_MAX_RETRIES },
      technicalIgnoredAt: null,
      ...(forceRetry ? {} : { nextFetchRetryAt: { lte: new Date() } }),
    },
    data: { fetchStatus: 'pending' },
  });

  const pendingWhere = { fetchStatus: 'pending' as const, technicalIgnoredAt: null };
  const total = await db.article.count({ where: pendingWhere });
  if (jobId) await startJobStage(jobId, { stage: 'process', total });
  let processed = 0;
  let errors = 0;
  // 每轮只取固定窗口。详情抓取会把 Article 转为 fetched/failed，因此已处理的
  // 项自然离开 where；不会因积压量把整张待处理列表留在 Node 内存中。
  while (true) {
    const page = await db.article.findMany({
      where: pendingWhere,
      select: { id: true, title: true, url: true, sourceId: true, publishedAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_BATCH_SIZE,
    });
    if (page.length === 0) break;
    for (let i = 0; i < page.length; i += PROCESS_CONCURRENCY) {
      assertNotAborted(signal);
      const batch = page.slice(i, i + PROCESS_CONCURRENCY);
      const errorsBeforeBatch = errors;
      await Promise.all(batch.map(async (article) => {
        try {
          const content = await withTimeout(
            timeoutSignal => fetchArticleDetail(article.id, 2, timeoutSignal),
            FETCH_TIMEOUT_MS,
            `详情抓取超时 "${article.title}"`,
            signal,
          );
          if (!content || content.length <= 50) {
            errors++;
            return;
          }

            // ---- 全文关键字匹配 ----
            // 关键词是入库门槛，不能沿用聚类指纹的前窗截断；命中正文后部也必须保留。
            try {
              const text = `${article.title} ${content}`;
            // 品牌白名单命中，或标题本身已是明确的餐饮/零售业态事件，均保留。
            // 便利店、超市、餐厅等行业报道不应因未提及已知品牌而在 AI 前被误删。
            const keywordMatch = await evaluateKeywordMatch(text);
            const retained = keywordMatch.blacklisted !== true && (
              !keywordMatch.configured
              || keywordMatch.matched
              || matchIndustryTitleSignal(article.title)
            );
            await db.article.update({
              where: { id: article.id },
              data: { keywordMatched: keywordMatch.matched },
            });
            await replaceArticleKeywordHits(article.id, keywordMatch.matchedWords);
            if (!retained) {
              try {
                await recordKeywordCandidates(article.title);
              } catch (candidateError) {
                if (signal?.aborted) throw candidateError;
                console.error('[processAllPending] keyword candidate recording failed:', candidateError);
              }
              const recorded = await recordDiscardedItem({
                sourceId: article.sourceId,
                title: article.title,
                url: article.url,
                reason: keywordMatch.blacklisted ? 'filter:blacklist' : 'filter:keyword',
                detail: keywordMatch.blacklisted
                  ? { matchedKeyword: keywordMatch.blacklistWord || '', sample: text.slice(0, 200) }
                  : { sample: text.slice(0, 200) },
                publishedAt: article.publishedAt?.toISOString(),
              });
              if (!recorded) {
                errors++;
                console.error(`[processAllPending] skipped deleting article=${article.id}: discarded audit failed`);
                return;
              }
              await db.article.delete({ where: { id: article.id } });
              console.log(`[processAllPending] keyword miss: "${article.title}", discarded`);
              return;
            }
          } catch (err) {
            // 关键字 DB 异常时不应阻塞 process —— 宁可放过不可误杀
            if (signal?.aborted) throw err;
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[processAllPending] keyword check failed for article=${article.id}:`, errMsg);
          }

          processed++;
          await refreshArticleSearchIndex(article.id);
        } catch (err) {
          if (signal?.aborted) throw err;
          errors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[processAllPending] fetch failed for article=${article.id} title="${article.title}":`, errMsg);
          // 超时/运行时异常可能在 fetchArticleDetail 写入失败状态之前从外层返回。
          // 不收口会让这篇文章永久保持 pending，并被 while 循环反复处理。
          await markArticleFetchFailure(article.id, err, { onlyIfPending: true });
        }
      }));
      if (jobId) {
        await advanceJobProgress(jobId, {
          doneDelta: batch.length,
          errorDelta: errors - errorsBeforeBatch,
          currentItemLabel: batch[batch.length - 1]?.title,
        });
      }
      if (i + PROCESS_CONCURRENCY < page.length) await abortableDelay(PROCESS_DELAY_MS, signal);
    }
  }

  // 修复已抓取文章的 publishedAt：从 rawContent 提取精确时间覆盖列表页的日期-only
  await repairPublishedDates(signal);
  return { total, processed, errors, capped: false };
}

/**
 * 遍历已采集文章，若 publishedAt 为 null 或日期-only（00:00:00），
 * 则尝试从已有 rawContent 提取精确发布时间覆盖列表页的日期-only。
 *
 * 只处理 fetchStatus='fetched' 且有 rawContent 的文章——直接从已抓取的
 * HTML 提取时间，不发起网络请求。pending 文章（从未抓详情）的 publishedAt
 * 会在后续 process 阶段由 fetchArticleDetail 的 extractMetaPublishedAt
 * 自然修复，避免这里重复抓取同一详情页。
 */
export async function repairPublishedDates(signal?: AbortSignal): Promise<void> {
  try {
    // 只扫描近 7 天已 fetched 且有 rawContent 的文章（时间从已有 HTML 提取，不抓网）。
    // 按 createdAt/id 做稳定 keyset 分页；更新 publishedAt 不会影响游标，避免把整周
    // raw HTML 一次装进内存。
    const sevenDaysAgo = new Date(Date.now() - REPAIR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    let cursor: { createdAt: Date; id: string } | null = null;
    while (true) {
      assertNotAborted(signal);
      const page: Array<Pick<Article, 'id' | 'title' | 'rawContent' | 'publishedAt' | 'createdAt'>> = await db.article.findMany({
        where: {
          fetchStatus: 'fetched',
          rawContent: { not: '' },
          createdAt: { gte: sevenDaysAgo },
          ...(cursor ? {
            AND: [{
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }],
          } : {}),
        },
        select: { id: true, title: true, rawContent: true, publishedAt: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: REPAIR_BATCH_SIZE,
      });
      if (page.length === 0) break;

      const needsRepair = page.filter(article =>
        !article.publishedAt || (article.publishedAt.getUTCHours() + article.publishedAt.getUTCMinutes() + article.publishedAt.getUTCSeconds()) === 0,
      );
      for (let i = 0; i < needsRepair.length; i += 5) {
        const batch = needsRepair.slice(i, i + 5);
        await Promise.all(
          batch.map(async (article) => {
            try {
              const detailDate = extractMetaPublishedAt(article.rawContent);
              if (detailDate) {
                await db.article.update({
                  where: { id: article.id },
                  data: { publishedAt: detailDate },
                });
                await refreshPublicPublication(article.id, db, { contentChanged: true });
                console.log(`[repairPublishedDates] fixed article=${article.id} title="${article.title}" → ${detailDate.toISOString()}`);
              }
            } catch (err) {
              if (signal?.aborted) throw err;
              console.error(`[repairPublishedDates] failed for article=${article.id}:`, err);
            }
          }),
        );
      }

      const last = page[page.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < REPAIR_BATCH_SIZE) break;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error('[repairPublishedDates] error:', err);
  }
}
