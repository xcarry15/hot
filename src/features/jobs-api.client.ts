/**
 * Jobs / crawler / worker API 的客户端层。
 *
 * - POST /api/crawl                  触发一次全量采集
 * - POST /api/worker/stop            中止当前 worker
 * 单篇恢复和重跑统一由 /api/articles/[id]/workflow 处理。
 * - POST /api/crawl { stage: 'push' } 批量推送
 * - POST /api/discarded/retry        重试被丢弃项
 */
import { requestJson } from '@/lib/request-json.client';

export const triggerFullCrawl = (signal?: AbortSignal) =>
  requestJson('POST', '/api/crawl', { body: '{}', signal });

/** 触发单个阶段（'all' 等价于 full pipeline） */
export const triggerCrawlStage = (
  stage: 'all' | 'collect' | 'process' | 'cluster' | 'ai' | 'push',
  signal?: AbortSignal,
) =>
  stage === 'all'
    ? triggerFullCrawl(signal)
    : requestJson('POST', '/api/crawl', { body: { stage }, signal });

export const stopWorker = (signal?: AbortSignal) =>
  requestJson('POST', '/api/worker/stop', { signal });


export const retryDiscarded = (
  discardedId: string,
  signal?: AbortSignal,
) => requestJson('POST', '/api/discarded/retry', { body: { id: discardedId }, signal });
