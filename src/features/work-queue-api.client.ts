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
const CACHE_TTL_MS = 5_000;

export async function fetchWorkQueueSummary(force = false): Promise<WorkQueueSummary> {
  if (!force && cachedData && Date.now() - lastFetchAt < CACHE_TTL_MS) {
    return cachedData;
  }
  const data = await requestJson<WorkQueueSummary>('GET', '/api/admin/work-queue-summary');
  cachedData = data;
  lastFetchAt = Date.now();
  return data;
}

export function invalidateWorkQueueCache(): void {
  cachedData = null;
  lastFetchAt = 0;
}
