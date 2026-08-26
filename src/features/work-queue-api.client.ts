import { requestJson } from '@/lib/request-json.client';

export interface WorkQueueSummary {
  technical: {
    total: number;
    sources: number;
    processFailed: number;
    clusterFailed: number;
    aiFailed: number;
    pushFailed: number;
    autoRetry: number;
  };
  human: {
    total: number;
    clusterReview: number;
    lowConfidence: number;
  };
}

let cachedData: WorkQueueSummary | null = null;
let lastFetchAt = 0;
let inFlightRequest: Promise<WorkQueueSummary> | null = null;
let cacheRevision = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPendingAfterFlight = false;
let refreshScheduled = false;
const listeners = new Set<(data: WorkQueueSummary) => void>();
const CACHE_TTL_MS = 5_000;
const MUTATION_REFRESH_DEBOUNCE_MS = 3_000;

export function fetchWorkQueueSummary(): Promise<WorkQueueSummary> {
  // A mutation refresh is intentionally trailing. During its debounce window,
  // serve the last known value instead of letting focus/tab events bypass it.
  if (refreshScheduled && cachedData) {
    return Promise.resolve(cachedData);
  }
  if (!refreshScheduled && cachedData && Date.now() - lastFetchAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedData);
  }
  if (inFlightRequest) return inFlightRequest;

  const requestRevision = cacheRevision;
  const request = (async () => {
    const data = await requestJson<WorkQueueSummary>('GET', '/api/admin/work-queue-summary');
    // Mutation invalidation may happen while the old request is in flight.
    // Never publish that response as current queue truth.
    if (requestRevision !== cacheRevision) return data;
    cachedData = data;
    lastFetchAt = Date.now();
    for (const listener of listeners) {
      try {
        listener(data);
      } catch {
        // A subscriber must not turn a successful queue request into a failed one.
      }
    }
    return data;
  })().finally(() => {
    if (inFlightRequest === request) inFlightRequest = null;
    if (refreshPendingAfterFlight && !inFlightRequest) {
      refreshPendingAfterFlight = false;
      void fetchWorkQueueSummary().catch(() => undefined);
    }
  });
  inFlightRequest = request;
  return request;
}

export function invalidateWorkQueueCache(): void {
  cachedData = null;
  lastFetchAt = 0;
  cacheRevision += 1;
  refreshScheduled = false;
}

/**
 * 写操作后的统一刷新入口：失效旧摘要，并把连续操作合并成一次尾部刷新。
 * 请求在飞时不立即追加请求；定时器到期后再补一次，避免旧响应覆盖新状态。
 */
export function scheduleWorkQueueSummaryRefresh(delayMs = MUTATION_REFRESH_DEBOUNCE_MS): void {
  cacheRevision += 1;
  refreshScheduled = true;
  refreshPendingAfterFlight = false;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshScheduled = false;
    cachedData = null;
    lastFetchAt = 0;
    if (inFlightRequest) {
      refreshPendingAfterFlight = true;
      return;
    }
    void fetchWorkQueueSummary().catch(() => undefined);
  }, Math.max(0, delayMs));
}

export function subscribeToWorkQueueSummary(listener: (data: WorkQueueSummary) => void): () => void {
  listeners.add(listener);
  if (cachedData && Date.now() - lastFetchAt < CACHE_TTL_MS) {
    try {
      listener(cachedData);
    } catch {
      // A subscriber must not affect other subscribers or the cache.
    }
  }
  return () => listeners.delete(listener);
}
