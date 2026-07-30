/**
 * Pipeline / collect 阶段应用服务。
 *
 * 单一职责：URL 去重 → 黑名单拦截 → 长度门控 → 入库（包含单条 collectItem、单源 crawlSource、
 * 全源 collectAllSources、与 source 预览 testCrawlSource）。
 */
import { db } from '@/lib/db';
import { evaluateKeywordMatch } from '@/lib/filter';
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
import { recordFailure, restoreBreakerIfElapsed } from '@/lib/pipeline/source-health';
import { refreshArticleSearchIndex } from '@/lib/article-search-index';
import type { CrawlItem, CrawlResult } from '@/contracts/crawl';
import type { Article, Source } from '@prisma/client';

const CRAWL_SOURCE_TIMEOUT_MS = 60_000;
const COLLECT_CONCURRENCY = 4;

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 单条 crawlItem 入口：
 *   - URL 精确去重（命中已处理 URL 仅更新列表元数据，不重置处理状态）
 *   - DiscardedItem 短路（关键词配置变更时会清理 filter:*，其余记录直接 skip）
 *   - 黑名单命中在已有列表字段时直接拦截；详情阶段再兜底
 *   - 长度门控（title < 10 且无 summary/detail content → filter:short）
 *   - 写 Article（P2002 race → 记 dedup:url 后短路）
 */
export type CollectItemResult = 'created' | 'existing' | 'discarded';

export async function collectItem(
  sourceId: string,
  sourceName: string,
  item: CrawlItem,
  knownExisting?: Article | null,
  knownDiscarded?: boolean,
): Promise<CollectItemResult> {
  // Normalize URL
  const normalizedUrl = normalizeUrl(item.url);
  // 解析器面对的是第三方页面；结构化选择器可能意外抓到 javascript:、
  // mailto: 等非文章链接。它们不能入库，更不能在公开页作为可点击链接输出。
  if (!isHttpUrl(normalizedUrl)) {
    console.warn(`[collectItem] skipped non-http URL from source=${sourceId}: ${item.url}`);
    return 'discarded';
  }

  // ---- Step 1: URL exact dedup ----
  const existing = knownExisting === undefined
    ? await db.article.findUnique({ where: { url: normalizedUrl } })
    : knownExisting;
  if (existing) {
    // 同 URL 视为同一篇文章：采集阶段绝不因列表标题/日期变化重跑详情、AI 或聚类。
    // 重新抓取只能由失败重试或管理员显式操作触发，避免常规采集反复消耗资源。
    const titleChanged = existing.title !== item.title;
    const nextPublishedAt = item.publishedAt ? parseChineseDate(item.publishedAt) : undefined;
    const publishedAtChanged = nextPublishedAt !== undefined
      && existing.publishedAt?.getTime() !== nextPublishedAt.getTime();
    if (titleChanged || publishedAtChanged) {
      await db.article.update({
        where: { id: existing.id },
        data: {
          ...(titleChanged ? { title: item.title } : {}),
          ...(publishedAtChanged ? { publishedAt: nextPublishedAt } : {}),
        },
      });
      await refreshArticleSearchIndex(existing.id);
      console.log(`[dedup] URL exact match, metadata updated: "${item.title}"`);
    } else {
      console.log(`[dedup] URL exact match, skipped: "${item.title}"`);
    }
    return 'existing';
  }

  // ---- Step 2: DiscardedItem blocking ----
  // filter:* 记录在关键词配置变更时会被清理；未变更时仍短路，避免反复抓取→丢弃。
  const discarded = knownDiscarded === undefined
    ? await db.discardedItem.findFirst({ where: { url: normalizedUrl } })
    : knownDiscarded
      ? { reason: '已丢弃' }
      : null;
  if (discarded) {
    console.log(`[collectItem] skipping previously discarded: "${item.title}" (reason: ${discarded.reason})`);
    return 'discarded';
  }

  // 黑名单在入库前优先拦截；列表页已有标题/摘要/正文时无需创建 Article。
  try {
    const blacklistMatch = await evaluateKeywordMatch(
      `${item.title} ${item.summary || ''} ${item.content || ''}`,
    );
    if (blacklistMatch.blacklisted) {
      await recordDiscardedItem({
        sourceId,
        title: item.title,
        url: normalizedUrl,
        reason: 'filter:blacklist',
        detail: { matchedKeyword: blacklistMatch.blacklistWord || '' },
        publishedAt: item.publishedAt,
      });
      console.log(`[collectItem] blacklist match, skipped before save: "${item.title}"`);
      return 'discarded';
    }
  } catch (error) {
    // 关键词 DB 异常时保持现有“放过不可误杀”策略。
    console.error(`[collectItem] blacklist check failed for article="${item.title}":`, error);
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
    return 'discarded';
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
    if (fetchStatus === 'fetched') await refreshArticleSearchIndex(created.id);

    return 'created';
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
      return 'discarded';
    }
    throw err;
  }
  // (函数内使用 sourceName 仅为兼容旧签名；目前被判定不会读取，但保留参数以避免调用方改动。)
  void sourceName;
  return 'discarded';
}

/**
 * 同一列表 URL 被删除后又重新添加时，Article 的 URL 全局唯一约束会让新来源
 * 永远无法入库。仅在新来源已成功解析列表后，接管同 URL 的已删除来源文章，
 * 并恢复此前未完成的正文抓取，避免产生第二份 Article 或长期不可见的孤儿记录。
 */
async function reclaimArticlesFromDeletedSource(source: Source): Promise<number> {
  const deletedSources = await db.source.findMany({
    where: {
      id: { not: source.id },
      url: source.url,
      deletedAt: { not: null },
    },
    select: { id: true },
  });
  if (deletedSources.length === 0) return 0;

  const result = await db.article.updateMany({
    where: {
      sourceId: { in: deletedSources.map((item) => item.id) },
      fetchStatus: { in: ['pending', 'failed'] },
    },
    data: {
      sourceId: source.id,
      fetchStatus: 'pending',
      fetchError: null,
      fetchRetryCount: 0,
      nextFetchRetryAt: null,
      technicalIgnoredAt: null,
      rawContent: '',
      cleanContent: '',
      articleBody: '',
      contentHash: '',
    },
  });

  // 已完成文章无需重跑，仍需归属到当前启用来源，才能在工作台正常显示。
  await db.article.updateMany({
    where: {
      sourceId: { in: deletedSources.map((item) => item.id) },
    },
    data: { sourceId: source.id },
  });

  if (result.count > 0) {
    console.log(`[collect] reclaimed ${result.count} pending article(s) from deleted source(s) for ${source.name}`);
  }
  return result.count;
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
      return { success: true, items: [], error: '0 items parsed' };
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


    // 列表已成功解析后才允许接管同 URL 的已删除来源，避免错误配置的来源夺取文章。
    const reclaimedCount = await reclaimArticlesFromDeletedSource(source);

    // 单批预取 URL 状态，把每条 2 次只读查询收敛为 2 次批量查询。
    const normalizedUrls = [...new Set(result.items.map((item) => normalizeUrl(item.url)))];
    const [existingArticles, discardedUrls] = await Promise.all([
      db.article.findMany({ where: { url: { in: normalizedUrls } } }),
      db.discardedItem.findMany({ where: { url: { in: normalizedUrls } }, select: { url: true } }),
    ]);
    const existingByUrl = new Map(existingArticles.map((article) => [article.url, article]));
    const discardedUrlSet = new Set(discardedUrls.map((item) => item.url));
    const processedUrls = new Set<string>();

    let createdCount = 0;
    let deduplicatedCount = 0;

    // Collect each item (no detail fetch, no AI — those are separate stages).
    for (const item of result.items) {
      assertNotAborted(signal);
      const normalizedUrl = normalizeUrl(item.url);
      if (processedUrls.has(normalizedUrl)) {
        console.log(`[collect] duplicate URL inside source response, skipped: ${normalizedUrl}`);
        continue;
      }
      processedUrls.add(normalizedUrl);
      const outcome = await collectItem(
        sourceId,
        source.name,
        item,
        existingByUrl.get(normalizedUrl) ?? null,
        discardedUrlSet.has(normalizedUrl),
      );
      if (outcome === 'created') createdCount++;
      if (outcome === 'existing') deduplicatedCount++;
    }

    return { ...result, createdCount, deduplicatedCount, reclaimedCount };
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
  let resultIndex = 0;

  const remainingSources = [...dueSources];
  while (remainingSources.length > 0) {
    assertNotAborted(signal);
    const usedHosts = new Set<string>();
    const batch: typeof dueSources = [];
    for (let index = 0; index < remainingSources.length && batch.length < COLLECT_CONCURRENCY;) {
      const candidate = remainingSources[index];
      const host = sourceHostname(candidate.url);
      if (usedHosts.has(host)) {
        index++;
        continue;
      }
      usedHosts.add(host);
      batch.push(candidate);
      remainingSources.splice(index, 1);
    }
    if (batch.length === 0) batch.push(remainingSources.shift()!);

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
          // crawlSource 在收到子超时信号时会原样抛出，以免把“任务取消”
          // 误记为来源失败。这里确认父任务仍在运行，说明是本来源的超时，
          // 必须补记健康状态和 FetchLog，才能触发后续熔断与人工告警。
          try {
            await recordFailure(source.id, msg);
          } catch (recordError) {
            console.error(`[collectAllSources] failed to record timeout source=${source.id}:`, recordError);
          }
          return { sourceId: source.id, sourceName: source.name, success: false, items: [], error: msg } as CrawlResult & { sourceId: string; sourceName: string };
        }
      })
    );

    // 按执行完成的批次顺序写入结果；每批最多一个同域来源，避免同站并发抓取。
    for (let j = 0; j < batchResults.length; j++) {
      results[resultIndex] = batchResults[j];
      resultIndex++;
      if (!batchResults[j].success) errors++;
      totalNewArticles += batchResults[j].createdCount ?? 0;
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
