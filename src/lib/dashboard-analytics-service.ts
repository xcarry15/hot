import { db } from '@/lib/db';
import { captureInboxSnapshot, listInboxSnapshots } from '@/lib/inbox-snapshot-service';

export type DashboardAnalyticsRange = 'today' | '3d' | '7d' | '30d';

interface RangeWindow {
  startAt: Date;
  endAt: Date;
  days: number;
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

interface MutableTrendStats extends MutableStats {
  date: Date;
}

type CrawlTrigger = 'auto' | 'manual' | 'unknown';

export interface CrawlRecordFilters {
  page?: number;
  trigger?: CrawlTrigger;
  status?: string;
  type?: 'full' | 'collect';
  sourceId?: string;
}

const CRAWL_PAGE_SIZE = 20;

const RANGE_DAYS: Record<DashboardAnalyticsRange, number> = {
  today: 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

export function parseDashboardAnalyticsRange(value: string | null): DashboardAnalyticsRange {
  if (value === '3d' || value === '7d' || value === '30d') return value;
  return 'today';
}

function getRangeWindow(range: DashboardAnalyticsRange): RangeWindow {
  const endAt = new Date();
  const startAt = new Date(endAt);
  startAt.setHours(0, 0, 0, 0);
  startAt.setDate(startAt.getDate() - RANGE_DAYS[range] + 1);
  return { startAt, endAt, days: RANGE_DAYS[range] };
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

function createTrendStats(date: Date): MutableTrendStats {
  return { date, ...createStats() };
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(value: number, denominator: number): number {
  return denominator > 0 ? round(value / denominator, 4) : 0;
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

function parseItemsFound(type: string, result: Record<string, unknown>): number | null {
  const stageResult = type === 'full'
    ? (result.stages as Record<string, unknown> | undefined)?.collect
    : result.result;
  if (!stageResult || typeof stageResult !== 'object' || Array.isArray(stageResult)) return null;

  const data = stageResult as Record<string, unknown>;
  if (typeof data.itemsFound === 'number') return data.itemsFound;
  const sources = data.sources;
  if (!Array.isArray(sources)) return null;
  return sources.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const itemsFound = (item as Record<string, unknown>).itemsFound;
    return total + (typeof itemsFound === 'number' ? itemsFound : 0);
  }, 0);
}

function toQualityStats(stats: MutableStats) {
  const pushedNonAds = Math.max(0, stats.pushed - stats.pushedAds);
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
    // 互斥堆叠分层：AI完成按普通/软文/已推送拆分，避免同一篇文章重复累加。
    stackNew: Math.max(0, stats.newArticles - stats.ads - pushedNonAds),
    stackAds: Math.max(0, stats.ads - stats.pushedAds),
    stackPushed: stats.pushed,
    stackDuplicates: stats.duplicates,
  };
}

export async function getDashboardAnalytics(
  range: DashboardAnalyticsRange = 'today',
  sourceId?: string,
  crawlFilters: CrawlRecordFilters = {},
) {
  const window = getRangeWindow(range);
  const timeWhere = { gte: window.startAt, lte: window.endAt };
  const sourceFilter = sourceId ? { sourceId } : {};

  // 积压趋势是派生快照，不阻塞主统计；采集/归类任务完成后也会更新同一快照。
  void captureInboxSnapshot().catch(() => undefined);

  const [sources, articles, discardedItems, fetchLogs, inboxPending, inboxSnapshots] = await Promise.all([
    db.source.findMany({
      where: { deletedAt: null, ...(sourceId ? { id: sourceId } : {}) },
      select: { id: true, name: true, status: true, enabled: true, lastFetchedAt: true },
      orderBy: { name: 'asc' },
    }),
    db.article.findMany({
      where: { createdAt: timeWhere, ...sourceFilter },
      select: {
        sourceId: true,
        createdAt: true,
        fetchStatus: true,
        aiStatus: true,
        score: true,
        isAd: true,
        pushedAt: true,
        dedupDetail: true,
        viewCount: true,
        originalClickCount: true,
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
    db.article.count({ where: { fetchStatus: 'fetched', reviewStatus: 'unreviewed' } }),
    listInboxSnapshots(7),
  ]);

  const recentJobs = await db.job.findMany({
    where: { type: { in: ['full', 'collect'] } },
    orderBy: { createdAt: 'desc' },
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

  const trendStats = new Map<string, MutableTrendStats>();
  const cursor = new Date(window.startAt);
  for (let index = 0; index < window.days; index += 1) {
    const date = new Date(cursor);
    date.setDate(window.startAt.getDate() + index);
    trendStats.set(dateKey(date), createTrendStats(date));
  }

  const getSourceStats = (id: string) => sourceStats.get(id);
  const getTrendStats = (date: Date) => trendStats.get(dateKey(date));

  for (const row of articles) {
    const source = getSourceStats(row.sourceId);
    const trend = getTrendStats(row.createdAt);
    if (!source || !trend) continue;

    source.ingested += 1;
    trend.ingested += 1;
    source.views += row.viewCount;
    source.originalClicks += row.originalClickCount;
    trend.views += row.viewCount;
    trend.originalClicks += row.originalClickCount;

    if (row.fetchStatus === 'fetched') {
      source.processed += 1;
      trend.processed += 1;
    }

    const isAnalyzed = row.fetchStatus === 'fetched' && row.aiStatus === 'done';
    if (isAnalyzed) {
      source.newArticles += 1;
      trend.newArticles += 1;
      source.analyzed += 1;
      source.scoreTotal += row.score;
      source.highScore += row.score >= 80 ? 1 : 0;
      source.ads += row.isAd ? 1 : 0;
      trend.analyzed += 1;
      trend.scoreTotal += row.score;
      trend.highScore += row.score >= 80 ? 1 : 0;
      trend.ads += row.isAd ? 1 : 0;
    }

    if (isAnalyzed && row.pushedAt) {
      source.pushed += 1;
      trend.pushed += 1;
      if (row.isAd) {
        source.pushedAds += 1;
        trend.pushedAds += 1;
      }
    }

    if (row.aiStatus === 'skipped' && row.dedupDetail) {
      source.duplicates += 1;
      source.duplicateArticles += 1;
      trend.duplicates += 1;
      trend.duplicateArticles += 1;
    }
  }

  for (const row of discardedItems) {
    const source = getSourceStats(row.sourceId);
    const trend = getTrendStats(row.createdAt);
    if (!source || !trend) continue;
    if (row.reason === 'filter:keyword') {
      source.unmatched += 1;
      trend.unmatched += 1;
    } else {
      source.duplicates += 1;
      source.discardedDuplicates += 1;
      trend.duplicates += 1;
      trend.discardedDuplicates += 1;
    }
  }

  for (const row of fetchLogs) {
    const source = getSourceStats(row.sourceId);
    const trend = getTrendStats(row.createdAt);
    if (!source || !trend) continue;
    source.found += row.itemsFound;
    source.fetchRuns += 1;
    source.fetchSuccesses += row.status === 'success' ? 1 : 0;
    source.fetchWarnings += row.status === 'warning' ? 1 : 0;
    source.fetchFailures += row.status === 'failure' ? 1 : 0;
    trend.found += row.itemsFound;
    trend.fetchRuns += 1;
    trend.fetchSuccesses += row.status === 'success' ? 1 : 0;
    trend.fetchWarnings += row.status === 'warning' ? 1 : 0;
    trend.fetchFailures += row.status === 'failure' ? 1 : 0;
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

  const trend = Array.from(trendStats.values()).map((item) => ({
    date: dateKey(item.date),
    label: `${item.date.getMonth() + 1}/${item.date.getDate()}`,
    ...toQualityStats(item),
  }));

  const sourceNameById = new Map(sources.map((source) => [source.id, source.name]));
  const allCrawlRecords = recentJobs
    .flatMap((job) => {
      const payload = parseRecord(job.payload);
      const payloadSourceId = typeof payload.sourceId === 'string' ? payload.sourceId : null;
      if (crawlFilters.sourceId && payloadSourceId !== crawlFilters.sourceId) return [];
      const startedAt = job.startedAt ?? job.createdAt;
      const completedAt = job.completedAt ?? (job.status === 'running' ? null : job.updatedAt);
      const durationEnd = completedAt ?? new Date();
      return [{
        id: job.id,
        type: job.type as 'full' | 'collect',
        trigger: parseTrigger(payload),
        status: job.status,
        sourceLabel: payloadSourceId ? (sourceNameById.get(payloadSourceId) ?? '单个数据源') : '全部数据源',
        startedAt: startedAt.toISOString(),
        completedAt: completedAt?.toISOString() ?? null,
        durationMs: Math.max(0, durationEnd.getTime() - startedAt.getTime()),
        itemsFound: parseItemsFound(job.type, parseRecord(job.result)),
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

  return {
    range,
    sourceId: sourceId ?? null,
    startAt: window.startAt.toISOString(),
    endAt: window.endAt.toISOString(),
    summary: {
      sourceCount: sources.length,
      ...toQualityStats(summaryStats),
    },
    sources: sourceRows,
    trend,
    crawlRecords,
    crawlPagination: {
      page: crawlPage,
      pageSize: CRAWL_PAGE_SIZE,
      total: totalCrawlRecords,
      totalPages: totalCrawlPages,
    },
    inbox: {
      pending: inboxPending,
      trend: inboxSnapshots.map((snapshot) => ({
        date: dateKey(snapshot.capturedOn),
        pending: snapshot.pendingCount,
      })),
    },
  };
}
