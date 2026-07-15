/**
 * Pipeline / process 阶段应用服务。
 *
 * 单一职责：
 *   - processAllPending：抓取 fetchStatus='pending' 的详情页 → 全文去重 → 关键字门控
 *   - repairPublishedDates：从 rawContent HTML 中提取精确发布时间，覆盖日期-only
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts` 中；B13 抽离后保留：
 *     · MAX_BATCH_SIZE=500、CONCURRENCY=5、DELAY_MS=150、FETCH_TIMEOUT_MS=30_000
 *     · 2 小时退避后的 fetchStatus='failed' → 'pending' 重置
 *     · Gate 1 全文去重失败仅 console.error 继续走 Gate 2
 *     · Gate 2 关键字 DB 异常仅 console.error 不阻塞主流程
 *     · repair 只处理近 7 天 fetched 且有 rawContent 的文章
 */
import { db } from '@/lib/db';
import { matchKeyword } from '@/lib/filter';
import { fetchArticleDetail } from '@/lib/detail-fetcher';
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { assertNotAborted } from '@/lib/worker-stop';
import { extractMetaPublishedAt } from '@/lib/date-utils';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';
import { findDuplicateArticle } from '@/lib/dedup';
import { recordDiscardedItem } from '@/lib/pipeline/discarded-items';
import { recordKeywordCandidates } from '@/lib/keyword-candidate-service';
import { captureInboxSnapshot } from '@/lib/inbox-snapshot-service';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 500;
const PROCESS_CONCURRENCY = 5;
const PROCESS_DELAY_MS = 150;
const REPAIR_WINDOW_DAYS = 7;

/**
 * Stage 2: Fetch detail pages for all articles with fetchStatus='pending'.
 * Updates fetchStatus='fetched' after a successful fetch with meaningful cleaned text.
 */
export async function processAllPending(signal?: AbortSignal, jobId?: string): Promise<{ total: number; processed: number; errors: number; capped: boolean }> {
  assertNotAborted(signal);

  // 重置"已抓取但正文为空"的文章，让它们重新进详情页流程。
  await db.article.updateMany({
    where: { cleanContent: '', fetchStatus: 'fetched' },
    data: { fetchStatus: 'pending' },
  });

  // 重置早期失败的详情抓取（至少 2 小时前），允许退避重试。
  // 网络波动、源站临时维护等可能导致暂时失败，不应永久放弃。
  // 2h 窗口匹配 scheduler 默认 crawl_interval_min（120 分钟），
  // 确保下次 process 周期才能重试，形成自然退避。
  await db.article.updateMany({
    where: {
      fetchStatus: 'failed',
      updatedAt: { lte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    },
    data: { fetchStatus: 'pending' },
  });

  const pending = await db.article.findMany({
    where: { fetchStatus: 'pending' },
    select: { id: true, title: true, url: true, sourceId: true, publishedAt: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_BATCH_SIZE,
  });

  if (pending.length >= MAX_BATCH_SIZE) {
    console.log(`[processAllPending] batch cap reached (${MAX_BATCH_SIZE}), remaining will be picked up next tick`);
  }

  if (jobId) {
    await startJobStage(jobId, { stage: 'process', total: pending.length });
  }

  let processed = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i += PROCESS_CONCURRENCY) {
    assertNotAborted(signal);
    const batch = pending.slice(i, i + PROCESS_CONCURRENCY);
    const errorsBeforeBatch = errors;
    await Promise.all(
      batch.map(async (article) => {
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

          // ---- Gate 1: 全文内容指纹 + 正文 LCS 去重 ----
          // 用 process 刚抓到的全文 content（不是 DB 里旧的 contentHash），
          // 排除自己防止自我命中。
          try {
            const dup = await findDuplicateArticle(article.title, content, article.id, article.sourceId);
            if (dup.isDuplicate && dup.dedupType) {
              // detail 存 canonical DedupEvidence（含去重方式/重复文章/URL/详情/内容对比片段），
              // 与 article.dedupDetail 同构 → 详情区用同一面板渲染。
              await db.article.update({
                where: { id: article.id },
                data: {
                  aiStatus: 'skipped',
                  score: 0,
                  skipReason: `[重复] 与 "${dup.matchedTitle ?? '已有文章'}" 内容重复`,
                  dedupDetail: JSON.stringify(dup.evidence ?? {
                    methodKey: dup.dedupType,
                    method: dup.dedupType === 'content_fingerprint' ? '内容指纹 (SHA-256)' : '正文相似',
                    matchedTitle: dup.matchedTitle ?? '',
                    matchedUrl: dup.matchedUrl ?? '',
                    matchedId: dup.matchedId,
                    similarity: dup.similarity,
                    detail: `similarity=${dup.similarity.toFixed(2)}`,
                  }),
                  duplicateStatus: 'duplicate',
                  duplicateOfId: dup.matchedId ?? null,
                },
              });
              console.log(
                `[processAllPending] dedup hit (${dup.dedupType}) ` +
                `sim=${dup.similarity.toFixed(2)}: "${article.title}" → "${dup.matchedTitle}", retained as duplicate`
              );
              processed++;
              return;
            }
          } catch (err) {
            // 去重失败不应阻塞 process 流程，记录错误后继续走关键字门控
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[processAllPending] dedup check failed for article=${article.id}:`, errMsg);
          }

          // ---- Gate 2: 全文关键字匹配 ----
          // 标题 + cleaned 前 1000 字（与 fingerprint 取窗一致，便于对称），
          // 子串命中即通过。
          try {
            const text = `${article.title} ${content.slice(0, 1000)}`;
            const matched = await matchKeyword(text);
            if (!matched) {
              try {
                await recordKeywordCandidates(article.title);
              } catch (candidateError) {
                console.error('[processAllPending] keyword candidate recording failed:', candidateError);
              }
              const recorded = await recordDiscardedItem({
                sourceId: article.sourceId,
                title: article.title,
                url: article.url,
                reason: 'filter:keyword',
                detail: { sample: text.slice(0, 200) },
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
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[processAllPending] keyword check failed for article=${article.id}:`, errMsg);
          }

          processed++;
        } catch (err) {
          if (signal?.aborted) throw err;
          errors++;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[processAllPending] fetch failed for article=${article.id} title="${article.title}":`, errMsg);
        }
      })
    );
    if (jobId) {
      await advanceJobProgress(jobId, {
        doneDelta: batch.length,
        errorDelta: errors - errorsBeforeBatch,
        currentItemLabel: batch[batch.length - 1]?.title,
      });
    }
    if (i + PROCESS_CONCURRENCY < pending.length) {
      await abortableDelay(PROCESS_DELAY_MS, signal);
    }
  }

  // 修复已抓取文章的 publishedAt：从 rawContent 提取精确时间覆盖列表页的日期-only
  await repairPublishedDates(signal);
  await captureInboxSnapshot().catch((error) => console.error('[processAllPending] inbox snapshot failed:', error));

  return { total: pending.length, processed, errors, capped: pending.length >= MAX_BATCH_SIZE };
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
    // 只拉近 7 天已 fetched 且有 rawContent 的文章（时间从已有 HTML 提取，不抓网）。
    // detail-fetcher 已对新文章提取 publishedAt，老文章若仍日期-only 大概率源站无精确时间，
    // 限制窗口避免随数据增长全表扫描越来越慢。
    const sevenDaysAgo = new Date(Date.now() - REPAIR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const toRepair = await db.article.findMany({
      where: {
        fetchStatus: 'fetched',
        rawContent: { not: '' },
        createdAt: { gte: sevenDaysAgo },
      },
      select: { id: true, title: true, url: true, rawContent: true, publishedAt: true, fetchStatus: true },
      orderBy: { createdAt: 'desc' },
    });

    // 只选出 publishedAt 为 null 或时间为 00:00:00（日期-only）的
    const needsRepair = toRepair.filter(a =>
      !a.publishedAt || (a.publishedAt.getUTCHours() + a.publishedAt.getUTCMinutes() + a.publishedAt.getUTCSeconds()) === 0
    );

    if (needsRepair.length === 0) return;

    console.log(`[repairPublishedDates] found ${needsRepair.length} articles to repair`);

    for (let i = 0; i < needsRepair.length; i += 5) {
      assertNotAborted(signal);
      const batch = needsRepair.slice(i, i + 5);
      await Promise.all(
        batch.map(async (article) => {
          try {
            const html = article.rawContent || null;
            if (!html) return;
            const detailDate = extractMetaPublishedAt(html);
            if (detailDate) {
              await db.article.update({
                where: { id: article.id },
                data: { publishedAt: detailDate },
              });
              console.log(`[repairPublishedDates] fixed article=${article.id} title="${article.title}" → ${detailDate.toISOString()}`);
            }
          } catch (err) {
            console.error(`[repairPublishedDates] failed for article=${article.id}:`, err);
          }
        })
      );
    }
  } catch (err) {
    console.error('[repairPublishedDates] error:', err);
  }
}
