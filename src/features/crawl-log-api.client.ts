import {
  CRAWL_LOG_DEFAULT_LIMIT,
  type CrawlLogJobStatusSnapshot,
  type CrawlLogSnapshot,
  type SourceProgress,
} from '@/contracts/crawl-log'
import { requestJson } from '@/lib/request-json.client'

export async function fetchCrawlLogSnapshot(limit = CRAWL_LOG_DEFAULT_LIMIT): Promise<CrawlLogSnapshot> {
  const data = await requestJson<Partial<CrawlLogSnapshot>>('GET', `/api/crawl-log/status?limit=${limit}`)
  return {
    activeJob: data.activeJob ?? null,
    latestJob: data.latestJob ?? null,
    runtime: data.runtime,
    sources: Array.isArray(data.sources) ? data.sources as SourceProgress[] : [],
    fetchedAt: typeof data.fetchedAt === 'number' ? data.fetchedAt : Date.now(),
    hasMoreArticles: data.hasMoreArticles === true,
    hasMoreDiscarded: data.hasMoreDiscarded === true,
    technicalTotal: typeof data.technicalTotal === 'number' ? data.technicalTotal : 0,
    autoRetryTotal: typeof data.autoRetryTotal === 'number' ? data.autoRetryTotal : 0,
  }
}

export function fetchCrawlLogJobStatus(): Promise<CrawlLogJobStatusSnapshot> {
  return requestJson<CrawlLogJobStatusSnapshot>('GET', '/api/crawl-log/status?mode=job')
}
