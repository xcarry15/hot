import type { CrawlLogSnapshot, SourceProgress } from '@/contracts/crawl-log'
import { requestJson } from '@/lib/request-json.client'

export async function fetchCrawlLogSnapshot(limit = 500): Promise<CrawlLogSnapshot> {
  const data = await requestJson<Partial<CrawlLogSnapshot>>('GET', `/api/crawl-log/status?limit=${limit}`)
  return {
    activeJob: data.activeJob ?? null,
    latestJob: data.latestJob ?? null,
    sources: Array.isArray(data.sources) ? data.sources as SourceProgress[] : [],
    fetchedAt: typeof data.fetchedAt === 'number' ? data.fetchedAt : Date.now(),
  }
}

