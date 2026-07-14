/**
 * Discarded item feature 的客户端 API 层。
 *
 *   - GET  /api/discarded/:id         查看被丢弃项详情
 *   - POST /api/discarded/retry      重试（与 jobs-api 的 retryDiscarded 同语义）
 */
import { requestJson } from '@/lib/request-json.client';

export interface DiscardedItemDto {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  reason: string;
  detail: string;
  parsedDetail: Record<string, unknown> | null;
  winnerArticleId: string | null;
  publishedAt: string | null;
  createdAt: string;
  source?: { name: string; type: string; url?: string };
  [key: string]: unknown;
}

export async function fetchDiscardedItem(
  id: string,
  signal?: AbortSignal,
): Promise<DiscardedItemDto> {
  return requestJson<DiscardedItemDto>('GET', `/api/discarded/${id}`, { signal });
}
