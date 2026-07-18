/**
 * Pipeline / collect 阶段应用服务。
 *
 * 单一职责：URL 去重 → 长度门控 → 入库（包含单条 collectItem、单源 crawlSource、
 * 全源 collectAllSources、与 source 预览 testCrawlSource）。
 *
 * 历史：
 *   - 逻辑原先全部内联在 `crawler.ts` 中（798 行）；B12 抽离后保留：
 *     · 并发数（COLLECT_CONCURRENCY=4）、超时（CRAWL_SOURCE_TIMEOUT_MS=60_000）
 *     · URL / DiscardedItem / length gate 的判定顺序与日志文案
 *     · fetchLog(success|warning|failure) 的 status 与字段
 *     · source update（reset / increment / 熔断恢复）的字段与值
 *   - discarded / failure / circuit-breaker 写作迁移至独立模块。
 */
import { db } from '@/lib/db';
import { dispatchParser } from '@/lib/parser-registry';
import { cleanContent, extractArticleBody, meaningfulTextLength } from '@/lib/cleaner';
import { withTimeout } from '@/lib/shared/async';
import { MIN_MEANINGFUL_CHARS } from '@/lib/shared/content-policy';
import { assertNotAborted } from '@/lib/worker-stop';
import { normalizeUrl } from '@/lib/url-utils';
import { parseChineseDate } from '@/lib/date-utils';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';
import { recordDiscardedItem } from '@/lib/pipeline/discarded-items';
import { buildAiResetDataForArticle } from '@/lib/article-ai-reset';
import { refreshPublicPublication } from '@/lib/public-publication-service';
import { recalculateEventById } from '@/lib/event-service';
import { recordFailure, restoreBreakerIfElapsed } from '@/lib/pipeline/source-health';
import type { CrawlItem, CrawlResult } from '@/contracts/crawl';

const CRAWL_SOURCE_TIMEOUT_MS = 60_000;
const COLLECT_CONCURRENCY = 4;

/**
 * 单条 crawlItem 入口：
 *   - URL 精确去重（命中则按需更新 title 或重置 fetchStatus）
 *   - DiscardedItem 短路（命中已丢弃记录直接 skip）
 *   - 长度门控（title < 10 且无 summary/detail content → filter:short）
 *   - 写 Article（P2002 race → 记 dedup:url 后短路）
 */
export async function collectItem(
  sourceId: string,
  sourceName: string,
  item: CrawlItem,
): Promise<string | undefined> {
  // Normalize URL
  const normalizedUrl = normalizeUrl(item.url);

  // ---- Step 1: URL exact dedup ----
  const existing = await db.article.findUnique({ where: { url: normalizedUrl } });
  if (existing) {
    // 同 URL 重新抓取 → 更新标题和日期
    // 如果标题变了，重置 fetchStatus 以触发详情重抓
    const titleChanged = existing.title !== item.title;
    const nextPublishedAt = item.publishedAt ? parseChineseDate(item.publishedAt) : undefined;
    const publishedAtChanged = nextPublishedAt !== undefined
      && existing.publishedAt?.getTime() !== nextPublishedAt.getTime();
    const resetData = titleChanged ? {
      ...buildAiResetDataForArticle(existing),
      event: { disconnect: true },
      clusterStatus: 'pending',
      clusteredAt: null,
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
      eventKey: '',
      fetchStatus: 'pending' as const,
    } : {};
    await db.article.update({
      where: { id: existing.id },
      data: {
        title: item.title,
        publishedAt: nextPublishedAt,
        ...resetData,
      },
    });
    if (titleChanged || publishedAtChanged) {
      await refreshPublicPublication(existing.id, db, { contentChanged: titleChanged });
    }
    if (titleChanged && existing.eventId) await recalculateEventById(existing.eventId);
    console.log(`[dedup] URL exact match, updated: "${item.title}"${titleChanged ? ' (title changed, reset fetchStatus)' : ''}`);
    return existing.id;
  }

  // ---- Step 2: DiscardedItem blocking ----
  // 如果该 URL 在之前采集周期已被丢弃（去重/关键词未命中），本次直接跳过，
  // 避免反复抓取→丢弃的死循环。
  const discarded = await db.discardedItem.findFirst({ where: { url: normalizedUrl } });
  if (discarded) {
    console.log(`[collectItem] skipping previously discarded: "${item.title}" (reason: ${discarded.reason})`);
    return;
  }

  // ---- Step 3: Length gate ----
  const hasDetailContent = meaningfulTextLength(item.content || '') >= MIN_MEANINGFUL_CHARS;
  if (!hasDetailContent && !item.summary && item.title.length < 10) {
    await recordDiscardedItem({
      sourceId,
      title: item.title,
      url: normalizedUrl,
      reason: 'filter:short',
      detail: { titleLength: item.title.length, hasSummary: !!item.summary, hasDetailContent },
      publishedAt: item.publishedAt,
    });
    return;
  }

  // 注意：关键字匹配已搬到 processAllPending，内容指纹由后续聚类使用。
  // 这里只做 URL 唯一约束 + 长度门控；item.content 只是列表页摘要，不能用于事件判断。

  // ---- Step 5: Save article (direct create, P2002 fallback) ----
  // SQLite WAL 模式下写操作串行化，Step 1 的 findUnique 后极不可能发生并发插入。
  // 直接用 create，P2002 作兜底，移除事务内冗余的二次 URL 检查。
  const rawContent = item.content || '';
  const cleaned = rawContent ? cleanContent(rawContent) : '';
  const fetchStatus: 'pending' | 'fetched' = cleaned.length >= MIN_MEANINGFUL_CHARS ? 'fetched' : 'pending';
  const articleBody = rawContent ? extractArticleBody(rawContent) : '';

  try {
    const created = await db.article.create({
      data: {
        sourceId,
        url: normalizedUrl,
        title: item.title,
        rawContent,
        cleanContent: cleaned,
        articleBody,
        // contentHash 留空，由 detail-fetcher 在抓详情后用全文重算写入
        fetchStatus,
        score: 50,
        aiStatus: 'pending',
        publishedAt: item.publishedAt ? parseChineseDate(item.publishedAt) : undefined,
      },
    });

    return created.id;
  } catch (err: unknown) {
    // P2002: 极少见 — 常规竞态已由 Step 1 URL 去重消除；极端并发下仍可能触发。
  // 不抛出中断整个 for 循环：按 URL 唯一约束命中跳过即可。
    // 注意：此处不执行 title-change update（P2002 概率极低，无必要），与 Step 1 的
    // 正常 update 路径一致——Step 1 已处理非并发场景下的标题更新。
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      console.log(`[collectItem] P2002 race for url=${normalizedUrl} — treating as dedup hit`);
      await recordDiscardedItem({
        sourceId,
        title: item.title,
        url: normalizedUrl,
        reason: 'dedup:url',
        detail: {
          methodKey: 'url',
          method: 'URL 精确匹配',
          matchedTitle: item.title,
          matchedUrl: normalizedUrl,
          detail: '同一 URL 已存在（并发写入冲突 P2002）',
        },
        publishedAt: item.publishedAt,
      });
      return;
    }
    throw err;
  }
  // (函数内使用 sourceName 仅为兼容旧签名；目前被判定不会读取，但保留参数以避免调用方改动。)
  void sourceName;
}

/**
 * 单源抓取：dispatchParser → collectItem 列表。
 * 失败走 recordFailure；熔断中返回 Circuit breaker active；空结果仅记 warning。
 */
export async function crawlSource(sourceId: string, signal?: AbortSignal): Promise<CrawlResult> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  if (!source) return { success: false, items: [], error: 'Source not found' };
  if (!source.enabled) return { success: false, items: [], error: 'Source disabled' };

  // Check circuit breaker
  if (
    source.status === 'breaker' &&
    source.circuitBreakerUntil &&
    new Date() < source.circuitBreakerUntil
  ) {
    return { success: false, items: [], error: 'Circuit breaker active' };
  }

  try {
    assertNotAborted(signal);

    // Progress is persisted by the owning Job stage. This low-level function
    // deliberately emits no stage events so callers cannot create duplicate
    // progress records for the same source.
    const result = await dispatchParser(source.type, source.url, source.parserConfig, signal);

    if (!result.success) {
      await recordFailure(sourceId, result.error || 'Unknown error');
      return result;
    }

    // "200 but 0 items" is a warning — site may have restructured, but the
    // request itself succeeded. Do NOT count as a failure (no consecutiveFailures
    // increment, no circuit breaker) — 6h breaker on a temporarily empty source
    // would block recovery. Log to fetchLog for visibility.
    if (result.items.length === 0) {
      await db.fetchLog.create({
        data: {
          sourceId,
          status: 'warning',
          itemsFound: 0,
          errorMessage: 'Success response but 0 items parsed (possible site restructure)',
        },
      });
      return { success: false, items: [], error: '0 items parsed' };
    }

    // Success - reset failure count and record the latest fetch time.
    await db.source.update({
      where: { id: sourceId },
      data: {
        consecutiveFailures: 0,
        status: 'normal',
        lastFetchedAt: new Date(),
      },
    });

    // Log success
    await db.fetchLog.create({
      data: {
        sourceId,
        status: 'success',
        itemsFound: result.items.length,
      },
    });


    // Collect each item (no detail fetch, no AI — those are separate stages).
    // 含同批次已入库的）。不再用 entity 互查（假阳性高，已废弃）。
    for (const item of result.items) {
      assertNotAborted(signal);
      await collectItem(sourceId, source.name, item);
    }

    return result;
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : 'Unknown crawl error';
    await recordFailure(sourceId, msg);
    return { success: false, items: [], error: msg };
  }
}

/**
 * 全 enabled 且非熔断 source 并发抓取。COLLECT_CONCURRENCY=4 是保守值。
 * 单一调度由 settings.crawl_interval_min 控制（不传 force）；本函数不区分来源。
 */
export async function collectAllSources(signal?: AbortSignal, jobId?: string) {
  const sources = await db.source.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      OR: [
        { status: { not: 'breaker' } },
        { circuitBreakerUntil: { lte: new Date() } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  // 全局唯一间隔:无 per-source interval,只需过滤仍在熔断的源。
  const now = Date.now();
  const dueSources = sources.filter(s => {
    if (s.status === 'breaker' && s.circuitBreakerUntil && now < s.circuitBreakerUntil.getTime()) {
      return false; // 熔断中 → 跳过
    }
    return true;
  });

  const skippedCount = sources.length - dueSources.length;
  if (skippedCount > 0) {
    const skippedReasons = sources
      .filter(s => !dueSources.includes(s))
      .map(s => s.name)
      .join(', ');
    console.log(`[collectAllSources] ${skippedCount} source(s) skipped (in circuit breaker): ${skippedReasons}`);
  }

  if (jobId) {
    await startJobStage(jobId, {
      stage: 'collect',
      total: dueSources.length,
    });
  }

  // 源间并发：不同源指向不同站点，无共享状态，天然可并发。
  // concurrency=4 是保守值——同站多源（如 canyin88 不同分类页）仍可能撞同站反爬，
  // 但 withTimeout(60s) 已兜底；用户若需更激进可在源级别配 delay。
  const results: Array<CrawlResult & { sourceId: string; sourceName: string }> = new Array(dueSources.length);
  let errors = 0;
  let totalNewArticles = 0;

  for (let i = 0; i < dueSources.length; i += COLLECT_CONCURRENCY) {
    assertNotAborted(signal);
    const batch = dueSources.slice(i, i + COLLECT_CONCURRENCY);

    // 熔断恢复 + start 事件：在并发抓取前串行处理（快，不产生网络 I/O），
    // 保证 start 事件带正确的 index/total（前端进度条按 index 定位）。
    for (let j = 0; j < batch.length; j++) {
      const source = batch[j];
      await restoreBreakerIfElapsed(source);
    }

    // 并发抓取本批源（各源独立站点，crawlSource 内部按 sourceId 隔离写库，无冲突）
    const batchResults = await Promise.all(
      batch.map(async (source) => {
        try {
          const result = await withTimeout(
            timeoutSignal => crawlSource(source.id, timeoutSignal),
            CRAWL_SOURCE_TIMEOUT_MS,
            `数据源抓取超时 "${source.name}"`,
            signal,
          );
          return { sourceId: source.id, sourceName: source.name, ...result };
        } catch (err) {
          if (signal?.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          return { sourceId: source.id, sourceName: source.name, success: false, items: [], error: msg } as CrawlResult & { sourceId: string; sourceName: string };
        }
      })
    );

    // 按原 index 放回 results，保持顺序稳定（summarizeCollectResult 依赖 results 数组）
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
      if (!batchResults[j].success) errors++;
      totalNewArticles += batchResults[j].items.length;
    }
    if (jobId) {
      const batchErrors = batchResults.filter(r => !r.success).length;
      await advanceJobProgress(jobId, {
        doneDelta: batch.length,
        errorDelta: batchErrors,
        currentItemLabel: batch[batch.length - 1]?.name,
      });
    }
  }

  return { results, totalNewArticles, errors };
}

/**
 * Test crawl a source (preview first 5 items, don't save)
 */
export async function testCrawlSource(
  type: string,
  url: string,
  parserConfig: string
): Promise<CrawlResult> {
  try {
    const result = await dispatchParser(type, url, parserConfig);
    // Return only first 5 items for preview
    return {
      ...result,
      items: result.items.slice(0, 5),
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Test crawl failed';
    return { success: false, items: [], error: msg };
  }
}
