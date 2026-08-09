import { db } from '@/lib/db';
import type { JobStatus } from '@prisma/client';
import { getPublicDateKey } from '@/lib/shared/public-date';

export type DashboardAnalyticsRange = 'all' | 'today' | '3d' | '7d' | '30d';

interface RangeWindow {
  startAt: Date | null;
  endAt: Date;
}

interface MutableStats {
  found: number;
  ingested: number;
  processed: number;
  newArticles: number;
  analyzed: number;
  scoreTotal: number;
  highScore: number;
  pushed: number;
  pushedAds: number;
  unmatched: number;
  duplicates: number;
  duplicateArticles: number;
  discardedDuplicates: number;
  ads: number;
  fetchRuns: number;
  fetchSuccesses: number;
  fetchWarnings: number;
  fetchFailures: number;
  views: number;
  originalClicks: number;
}

type CrawlTrigger = 'auto' | 'manual' | 'unknown';

export interface CrawlRecordFilters {
  page?: number;
  trigger?: CrawlTrigger;
  status?: JobStatus;
  type?: 'full' | 'collect';
  sourceId?: string;
}

const CRAWL_PAGE_SIZE = 10;
const DASHBOARD_CACHE_TTL_MS = 15_000;
const DASHBOARD_CACHE_MAX_ENTRIES = 30;
const RANGE_DAYS: Record<Exclude<DashboardAnalyticsRange, 'all'>, number> = {
  today: 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

export function parseDashboardAnalyticsRange(value: string | null): DashboardAnalyticsRange {
  if (value === 'all') return value;
  if (value === 'today' || value === '3d' || value === '7d' || value === '30d') return value;
  return '7d';
}

/**
 * 所有概览日期都以 Asia/Shanghai 业务日切分，不能依赖部署机器的时区。
 * 上海无夏令时，+08:00 是这个业务边界的稳定 UTC 表示。
 */
export function getDashboardRangeWindow(
  range: DashboardAnalyticsRange,
  now = new Date(),
): RangeWindow {
  if (range === 'all') return { startAt: null, endAt: now };
  const endKey = dateKey(now);
  const startAt = new Date(`${endKey}T00:00:00+08:00`);
  startAt.setUTCDate(startAt.getUTCDate() - RANGE_DAYS[range] + 1);
  return { startAt, endAt: now };
}

function createStats(): MutableStats {
  return {
    found: 0,
    ingested: 0,
    processed: 0,
    newArticles: 0,
    analyzed: 0,
    scoreTotal: 0,
    highScore: 0,
    pushed: 0,
    pushedAds: 0,
    unmatched: 0,
    duplicates: 0,
    duplicateArticles: 0,
    discardedDuplicates: 0,
    ads: 0,
    fetchRuns: 0,
    fetchSuccesses: 0,
    fetchWarnings: 0,
    fetchFailures: 0,
    views: 0,
    originalClicks: 0,
  };
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(value: number, denominator: number): number {
  return denominator > 0 ? round(value / denominator, 4) : 0;
}

function dateKey(value: Date): string {
  return getPublicDateKey(value);
}

function isWithinRange(value: Date, window: RangeWindow): boolean {
  return value.getTime() <= window.endAt.getTime()
    && (window.startAt === null || value.getTime() >= window.startAt.getTime());
}

function dailyArticleChartKeys(range: DashboardAnalyticsRange, endAt: Date, firstArticleAt: Date | null): string[] {
  const endKey = dateKey(endAt);
  const cursor = new Date(`${endKey}T00:00:00.000Z`);
  const firstKey = firstArticleAt ? dateKey(firstArticleAt) : endKey;
  const firstDay = new Date(`${firstKey}T00:00:00.000Z`);
  const days = range === 'all'
    ? Math.max(0, Math.floor((cursor.getTime() - firstDay.getTime()) / 86_400_000) + 1)
    : RANGE_DAYS[range];
  const keys: string[] = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(cursor);
    day.setUTCDate(day.getUTCDate() - index);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseTrigger(payload: Record<string, unknown>): CrawlTrigger {
  return payload.trigger === 'auto' || payload.trigger === 'manual' ? payload.trigger : 'unknown';
}

function parseNewArticles(type: string, result: Record<string, unknown>): number | null {
  const stageResult = type === 'full'
    ? (result.stages as Record<string, unknown> | undefined)?.collect
    : result.result;
  if (!stageResult || typeof stageResult !== 'object' || Array.isArray(stageResult)) return null;

  const data = stageResult as Record<string, unknown>;
  if (typeof data.totalNewArticles === 'number') return Math.max(0, data.totalNewArticles);
  if (typeof data.newArticles === 'number') return Math.max(0, data.newArticles);
  const sources = data.sources;
  if (!Array.isArray(sources)) return null;
  return sources.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const newArticles = (item as Record<string, unknown>).newArticles;
    return total + (typeof newArticles === 'number' ? Math.max(0, newArticles) : 0);
  }, 0);
}

function parsePayloadSourceIds(payload: Record<string, unknown>): string[] {
  const sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
  const singleSourceId = typeof payload.sourceId === 'string' ? [payload.sourceId] : [];
  return [...new Set([...singleSourceId, ...sourceIds.filter((value): value is string => typeof value === 'string' && value.length > 0)])];
}

/**
 * 数据源筛选的语义是“本任务是否会采集此源”。full 且未跳过 collect 的任务会覆盖
 * 所有启用源，不能因为 payload 没有单个 sourceId 就从历史中消失。
 */
function jobCollectsSource(job: { type: string }, payload: Record<string, unknown>, sourceId: string): boolean {
  const payloadSourceIds = parsePayloadSourceIds(payload);
  if (payloadSourceIds.length > 0) return payloadSourceIds.includes(sourceId);
  return job.type === 'full' && payload.skipCollect !== true;
}

function toQualityStats(stats: MutableStats) {
  const totalArticles = stats.ingested + stats.unmatched + stats.discardedDuplicates;
  return {
    found: stats.found,
    ingested: stats.ingested,
    totalArticles,
    processed: stats.processed,
    processedRate: ratio(stats.processed, stats.ingested),
    newArticles: stats.newArticles,
    analyzed: stats.analyzed,
    avgScore: stats.analyzed > 0 ? round(stats.scoreTotal / stats.analyzed) : 0,
    highScore: stats.highScore,
    highScoreRate: ratio(stats.highScore, stats.analyzed),
    pushed: stats.pushed,
    pushRate: ratio(stats.pushed, totalArticles),
    qualifiedPushRate: ratio(stats.pushed, stats.analyzed),
    pushedAds: stats.pushedAds,
    unmatched: stats.unmatched,
    unmatchedRate: ratio(stats.unmatched, totalArticles),
    duplicates: stats.duplicates,
    duplicateArticles: stats.duplicateArticles,
    discardedDuplicates: stats.discardedDuplicates,
    duplicateRate: ratio(stats.duplicates, totalArticles),
    ads: stats.ads,
    adRate: ratio(stats.ads, totalArticles),
    fetchRuns: stats.fetchRuns,
    fetchSuccesses: stats.fetchSuccesses,
    fetchWarnings: stats.fetchWarnings,
    fetchFailures: stats.fetchFailures,
    views: stats.views,
    originalClicks: stats.originalClicks,
    clickRate: ratio(stats.originalClicks, stats.views),
  };
}

async function buildDashboardAnalytics(
  range: DashboardAnalyticsRange = '7d',
  sourceId?: string,
  crawlFilters: CrawlRecordFilters = {},
) {
  const window = getDashboardRangeWindow(range);
  const timeWhere = window.startAt
    ? { gte: window.startAt, lte: window.endAt }
    : { lte: window.endAt };
  const interactionDateWhere = window.startAt
    ? { gte: dateKey(window.startAt), lte: dateKey(window.endAt) }
    : { lte: dateKey(window.endAt) };
  const sourceFilter = sourceId ? { sourceId } : {};
  const eventSourceFilter = sourceId ? { representativeArticle: { is: { sourceId } } } : {};

  const [
    sources,
    articles,
    discardedItems,
    fetchLogs,
    interactionBySource,
    interactionByEvent,
    eventActivities,
  ] = await Promise.all([
    db.source.findMany({
      where: { deletedAt: null, ...(sourceId ? { id: sourceId } : {}) },
      select: { id: true, name: true, status: true, enabled: true, lastFetchedAt: true },
      orderBy: { name: 'asc' },
    }),
    db.article.findMany({
      where: { createdAt: timeWhere, ...sourceFilter },
      select: {
        id: true,
        sourceId: true,
        createdAt: true,
        fetchStatus: true,
        aiStatus: true,
        skipReason: true,
        aiSnapshot: true,
        score: true,
        isAd: true,
        clusterStatus: true,
        event: {
          select: {
            articleCount: true,
            representativeArticleId: true,
          },
        },
      },
    }),
    db.discardedItem.findMany({
      where: {
        createdAt: timeWhere,
        ...sourceFilter,
        OR: [
          { reason: { startsWith: 'dedup:' } },
          { reason: 'filter:keyword' },
        ],
      },
      select: { sourceId: true, createdAt: true, reason: true },
    }),
    db.fetchLog.findMany({
      where: { createdAt: timeWhere, ...sourceFilter },
      select: { sourceId: true, createdAt: true, status: true, itemsFound: true },
    }),
    db.eventInteractionDaily.groupBy({
      where: {
        dateKey: interactionDateWhere,
        ...(sourceId ? { sourceId } : {}),
      },
      by: ['sourceId'],
      _sum: { viewCount: true, originalClickCount: true },
    }),
    db.eventInteractionDaily.groupBy({
      where: {
        dateKey: interactionDateWhere,
        ...(sourceId ? { sourceId } : {}),
      },
      by: ['eventId'],
      _sum: { viewCount: true, originalClickCount: true },
    }),
    db.event.findMany({
      where: {
        ...eventSourceFilter,
        OR: [
          { publicPublishedAt: timeWhere },
          { pushedAt: timeWhere },
        ],
      },
      select: {
        id: true,
        publicPublishedAt: true,
        pushedAt: true,
        representativeArticle: {
          select: { sourceId: true, isAd: true },
        },
      },
    }),
  ]);

  const recentJobs = await db.job.findMany({
    where: { type: { in: ['full', 'collect'] }, createdAt: timeWhere },
    orderBy: { createdAt: 'desc' },
    // 运营页只显示近期历史；避免为了当前分页读取无限 Job。
    take: 500,
    select: {
      id: true,
      type: true,
      status: true,
      payload: true,
      result: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
    },
  });

  const sourceStats = new Map<string, MutableStats>();
  for (const source of sources) sourceStats.set(source.id, createStats());

  const getSourceStats = (id: string) => sourceStats.get(id);

  for (const row of articles) {
    const source = getSourceStats(row.sourceId);
    if (!source) continue;

    source.ingested += 1;

    if (row.fetchStatus === 'fetched') {
      source.processed += 1;
    }

    const businessSkipAnalyzed = row.aiStatus === 'skipped'
      && row.skipReason === '无价值'
      && row.aiSnapshot !== '{}';
    const isAnalyzed = row.fetchStatus === 'fetched'
      && (row.aiStatus === 'done' || businessSkipAnalyzed);
    if (isAnalyzed) {
      source.newArticles += 1;
      source.analyzed += 1;
      source.scoreTotal += row.score;
      source.highScore += row.score >= 80 ? 1 : 0;
      source.ads += row.isAd ? 1 : 0;
    }

    // Event 只有一篇代表文章；重复数应只计非代表成员，
    // 否则两篇稿件的 Event 会被误算成 2 篇重复稿。
    if ((row.event?.articleCount ?? 0) > 1 && row.event?.representativeArticleId !== row.id) {
      source.duplicates += 1;
      source.duplicateArticles += 1;
    }
  }

  for (const row of discardedItems) {
    const source = getSourceStats(row.sourceId);
    if (!source) continue;
    if (row.reason === 'filter:keyword') {
      source.unmatched += 1;
    } else {
      source.duplicates += 1;
      source.discardedDuplicates += 1;
    }
  }

  for (const row of fetchLogs) {
    const source = getSourceStats(row.sourceId);
    if (!source) continue;
    source.found += row.itemsFound;
    source.fetchRuns += 1;
    source.fetchSuccesses += row.status === 'success' ? 1 : 0;
    source.fetchWarnings += row.status === 'warning' ? 1 : 0;
    source.fetchFailures += row.status === 'failure' ? 1 : 0;
  }

  // 互动按发生日与发生时来源累加，绝不能把 Article 的生命周期累计值归到文章入库日。
  for (const row of interactionBySource) {
    const source = getSourceStats(row.sourceId);
    if (!source) continue;
    source.views += row._sum.viewCount ?? 0;
    source.originalClicks += row._sum.originalClickCount ?? 0;
  }

  // 推送是 Event 级动作；按 pushedAt 统计，避免“旧文章今天被推送”落到其入库日。
  for (const event of eventActivities) {
    const representative = event.representativeArticle;
    if (!representative) continue;
    const source = getSourceStats(representative.sourceId);
    if (!source || !event.pushedAt || !isWithinRange(event.pushedAt, window)) continue;
    source.pushed += 1;
    if (representative.isAd) source.pushedAds += 1;
  }

  const sourceRows = sources.map((source) => ({
    id: source.id,
    name: source.name,
    status: source.status,
    enabled: source.enabled,
    lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
    ...toQualityStats(sourceStats.get(source.id) ?? createStats()),
  }));

  const summaryStats = sources.reduce((total, source) => {
    const current = sourceStats.get(source.id) ?? createStats();
    for (const key of Object.keys(total) as Array<keyof MutableStats>) {
      total[key] += current[key];
    }
    return total;
  }, createStats());

  const sourceNameById = new Map(sources.map((source) => [source.id, source.name]));
  const allCrawlRecords = recentJobs
    .flatMap((job) => {
      const payload = parseRecord(job.payload);
      const payloadSourceIds = parsePayloadSourceIds(payload);
      const payloadSourceId = payloadSourceIds.length === 1 ? payloadSourceIds[0] : null;
      if (crawlFilters.sourceId && !jobCollectsSource(job, payload, crawlFilters.sourceId)) return [];
      const startedAt = job.startedAt ?? job.createdAt;
      const completedAt = job.completedAt ?? (job.status === 'running' ? null : job.updatedAt);
      const durationEnd = completedAt ?? new Date();
      return [{
        id: job.id,
        type: job.type as 'full' | 'collect',
        trigger: parseTrigger(payload),
        status: job.status,
        sourceLabel: payloadSourceId
          ? (sourceNameById.get(payloadSourceId) ?? '单个数据源')
          : payloadSourceIds.length > 1
            ? `${payloadSourceIds.length} 个数据源`
            : job.type === 'full' && payload.skipCollect !== true
              ? '全部数据源'
              : '未采集数据源',
        startedAt: startedAt.toISOString(),
        completedAt: completedAt?.toISOString() ?? null,
        durationMs: Math.max(0, durationEnd.getTime() - startedAt.getTime()),
        newArticles: parseNewArticles(job.type, parseRecord(job.result)),
        error: job.error || null,
      }];
    })
    .filter((record) => {
      if (crawlFilters.trigger && record.trigger !== crawlFilters.trigger) return false;
      if (crawlFilters.status && record.status !== crawlFilters.status) return false;
      if (crawlFilters.type && record.type !== crawlFilters.type) return false;
      return true;
    });

  const totalCrawlRecords = allCrawlRecords.length;
  const totalCrawlPages = totalCrawlRecords === 0 ? 0 : Math.ceil(totalCrawlRecords / CRAWL_PAGE_SIZE);
  const requestedCrawlPage = Math.max(1, crawlFilters.page ?? 1);
  const crawlPage = totalCrawlPages > 0 ? Math.min(requestedCrawlPage, totalCrawlPages) : 1;
  const crawlRecords = allCrawlRecords.slice(
    (crawlPage - 1) * CRAWL_PAGE_SIZE,
    crawlPage * CRAWL_PAGE_SIZE,
  );

  const firstArticleAt = articles.reduce<Date | null>((first, article) => (
    first === null || article.createdAt.getTime() < first.getTime() ? article.createdAt : first
  ), null);
  const dailyArticleKeys = dailyArticleChartKeys(range, window.endAt, firstArticleAt);
  const dailyArticleCounts = new Map(dailyArticleKeys.map((key) => [key, {
    newCount: 0,
    publicCount: 0,
    pushedCount: 0,
  }]));
  for (const article of articles) {
    const key = dateKey(article.createdAt);
    const counts = dailyArticleCounts.get(key);
    if (!counts) continue;
    counts.newCount += 1;
  }
  for (const event of eventActivities) {
    if (event.publicPublishedAt && isWithinRange(event.publicPublishedAt, window)) {
      const counts = dailyArticleCounts.get(dateKey(event.publicPublishedAt));
      if (counts) counts.publicCount += 1;
    }
    if (event.pushedAt && isWithinRange(event.pushedAt, window)) {
      const counts = dailyArticleCounts.get(dateKey(event.pushedAt));
      if (counts) counts.pushedCount += 1;
    }
  }

  const rankedInteractionEvents = interactionByEvent
    .map((row) => ({
      eventId: row.eventId,
      viewCount: row._sum.viewCount ?? 0,
      originalClickCount: row._sum.originalClickCount ?? 0,
    }))
    .filter((row) => row.viewCount > 0 || row.originalClickCount > 0)
    .sort((left, right) => right.viewCount - left.viewCount
      || right.originalClickCount - left.originalClickCount
      || right.eventId.localeCompare(left.eventId));
  // 已合并的历史 Event 没有代表 Article。分块继续读取直到得到 20 篇，既避免
  // SQLite IN 参数上限，也不会因前 100 条都已合并而错误显示空 Top 榜。
  const topViewedArticles: Array<{
    id: string;
    title: string;
    viewCount: number;
    publishedAt: string | null;
    score: number;
    sourceName: string;
  }> = [];
  const TOP_EVENT_QUERY_CHUNK_SIZE = 100;
  for (let offset = 0; offset < rankedInteractionEvents.length && topViewedArticles.length < 20; offset += TOP_EVENT_QUERY_CHUNK_SIZE) {
    const rankedChunk = rankedInteractionEvents.slice(offset, offset + TOP_EVENT_QUERY_CHUNK_SIZE);
    const eventRows = await db.event.findMany({
      where: { id: { in: rankedChunk.map((row) => row.eventId) }, representativeArticleId: { not: null } },
      select: {
        id: true,
        representativeArticle: {
          select: {
            id: true,
            title: true,
            publishedAt: true,
            score: true,
            source: { select: { name: true } },
          },
        },
      },
    });
    const eventById = new Map(eventRows.map((event) => [event.id, event]));
    for (const interaction of rankedChunk) {
      if (topViewedArticles.length >= 20) break;
      const article = eventById.get(interaction.eventId)?.representativeArticle;
      if (!article) continue;
      topViewedArticles.push({
        id: article.id,
        title: article.title,
        viewCount: interaction.viewCount,
        publishedAt: article.publishedAt?.toISOString() ?? null,
        score: article.score,
        sourceName: article.source.name,
      });
    }
  }

  return {
    range,
    sourceId: sourceId ?? null,
    startAt: window.startAt?.toISOString() ?? null,
    endAt: window.endAt.toISOString(),
    summary: {
      sourceCount: sources.length,
      ...toQualityStats(summaryStats),
    },
    sources: sourceRows,
    topViewedArticles,
    dailyNewArticles: dailyArticleKeys.map((date) => ({
      date,
      count: dailyArticleCounts.get(date)?.newCount ?? 0,
      publicCount: dailyArticleCounts.get(date)?.publicCount ?? 0,
      pushedCount: dailyArticleCounts.get(date)?.pushedCount ?? 0,
    })),
    crawlRecords,
    crawlPagination: {
      page: crawlPage,
      pageSize: CRAWL_PAGE_SIZE,
      total: totalCrawlRecords,
      totalPages: totalCrawlPages,
    },
  };
}

type DashboardAnalyticsResult = Awaited<ReturnType<typeof buildDashboardAnalytics>>;
const dashboardAnalyticsCache = new Map<string, {
  expiresAt: number;
  value: Promise<DashboardAnalyticsResult>;
}>();

export function invalidateDashboardAnalyticsCache(): void {
  dashboardAnalyticsCache.clear();
}

export function getDashboardAnalytics(
  range: DashboardAnalyticsRange = '7d',
  sourceId?: string,
  crawlFilters: CrawlRecordFilters = {},
): Promise<DashboardAnalyticsResult> {
  const key = JSON.stringify({
    range,
    sourceId: sourceId ?? '',
    page: crawlFilters.page ?? 1,
    trigger: crawlFilters.trigger ?? '',
    status: crawlFilters.status ?? '',
    type: crawlFilters.type ?? '',
    crawlSourceId: crawlFilters.sourceId ?? '',
  });
  const cached = dashboardAnalyticsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) dashboardAnalyticsCache.delete(key);
  const value = buildDashboardAnalytics(range, sourceId, crawlFilters);
  dashboardAnalyticsCache.set(key, { expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS, value });
  while (dashboardAnalyticsCache.size > DASHBOARD_CACHE_MAX_ENTRIES) {
    const oldestKey = dashboardAnalyticsCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    dashboardAnalyticsCache.delete(oldestKey);
  }
  void value.catch(() => dashboardAnalyticsCache.delete(key));
  return value;
}
