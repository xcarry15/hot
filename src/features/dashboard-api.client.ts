/**
 * Dashboard 客户端 API。
 */
import { requestJson } from '@/lib/request-json.client';

export interface FeedbackSuggestion {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: string;
  createdAt: string;
}

export async function fetchFeedbackSuggestions(signal?: AbortSignal): Promise<FeedbackSuggestion[]> {
  return requestJson<FeedbackSuggestion[]>('GET', '/api/feedback', { signal });
}

export async function updateFeedbackSuggestion(id: string, action: 'apply' | 'dismiss'): Promise<unknown> {
  return requestJson('POST', '/api/feedback', { body: { id, action } });
}

export type DashboardAnalyticsRange = 'today' | '3d' | '7d' | '30d';

export type DashboardCrawlTrigger = 'auto' | 'manual' | 'unknown';
export type DashboardCrawlStatus = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'completed' | 'failed' | 'cancelled';
export type DashboardCrawlType = 'full' | 'collect';

export interface DashboardCrawlQuery {
  page?: number;
  trigger?: DashboardCrawlTrigger;
  status?: DashboardCrawlStatus;
  type?: DashboardCrawlType;
  sourceId?: string;
}

export interface DashboardAnalytics {
  range: DashboardAnalyticsRange;
  sourceId: string | null;
  startAt: string;
  endAt: string;
  summary: {
    sourceCount: number;
    found: number;
    ingested: number;
    totalArticles: number;
    processed: number;
    processedRate: number;
    newArticles: number;
    analyzed: number;
    avgScore: number;
    highScore: number;
    highScoreRate: number;
    pushed: number;
    pushRate: number;
    qualifiedPushRate: number;
    pushedAds: number;
    unmatched: number;
    unmatchedRate: number;
    duplicates: number;
    duplicateArticles: number;
    discardedDuplicates: number;
    duplicateRate: number;
    ads: number;
    adRate: number;
    fetchRuns: number;
    fetchSuccesses: number;
    fetchWarnings: number;
    fetchFailures: number;
    views: number;
    originalClicks: number;
    clickRate: number;
  };
  sources: Array<{
    id: string;
    name: string;
    status: string;
    enabled: boolean;
    lastFetchedAt: string | null;
    found: number;
    ingested: number;
    totalArticles: number;
    processed: number;
    processedRate: number;
    newArticles: number;
    analyzed: number;
    avgScore: number;
    highScore: number;
    highScoreRate: number;
    pushed: number;
    pushRate: number;
    qualifiedPushRate: number;
    pushedAds: number;
    unmatched: number;
    unmatchedRate: number;
    duplicates: number;
    duplicateArticles: number;
    discardedDuplicates: number;
    duplicateRate: number;
    ads: number;
    adRate: number;
    fetchRuns: number;
    fetchSuccesses: number;
    fetchWarnings: number;
    fetchFailures: number;
    views: number;
    originalClicks: number;
    clickRate: number;
  }>;
  trend: Array<{
    date: string;
    label: string;
    found: number;
    ingested: number;
    totalArticles: number;
    processed: number;
    processedRate: number;
    newArticles: number;
    analyzed: number;
    avgScore: number;
    highScore: number;
    highScoreRate: number;
    pushed: number;
    pushRate: number;
    qualifiedPushRate: number;
    pushedAds: number;
    unmatched: number;
    unmatchedRate: number;
    duplicates: number;
    duplicateArticles: number;
    discardedDuplicates: number;
    duplicateRate: number;
    ads: number;
    adRate: number;
    fetchRuns: number;
    fetchSuccesses: number;
    fetchWarnings: number;
    fetchFailures: number;
    stackNew: number;
    stackAds: number;
    stackPushed: number;
    stackDuplicates: number;
  }>;
  crawlRecords: Array<{
    id: string;
    type: 'full' | 'collect';
    trigger: 'auto' | 'manual' | 'unknown';
    status: DashboardCrawlStatus;
    sourceLabel: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number;
    itemsFound: number | null;
    error: string | null;
  }>;
  crawlPagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  inbox: {
    pending: number;
    trend: Array<{ date: string; pending: number }>;
  };
}

export async function fetchDashboardAnalytics(
  range: DashboardAnalyticsRange,
  sourceId?: string,
  signal?: AbortSignal,
  crawl?: DashboardCrawlQuery,
): Promise<DashboardAnalytics> {
  const params = new URLSearchParams({ range });
  if (sourceId) params.set('sourceId', sourceId);
  if (crawl?.page) params.set('crawlPage', String(crawl.page));
  if (crawl?.trigger) params.set('crawlTrigger', crawl.trigger);
  if (crawl?.status) params.set('crawlStatus', crawl.status);
  if (crawl?.type) params.set('crawlType', crawl.type);
  if (crawl?.sourceId) params.set('crawlSourceId', crawl.sourceId);
  return requestJson<DashboardAnalytics>('GET', `/api/dashboard/analytics?${params.toString()}`, { signal });
}
