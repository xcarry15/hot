/**
 * PushLog 客户端 API。
 */
import { requestJson } from '@/lib/request-json.client';

export interface PushLogListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  source?: string;
  webhookRemark?: string;
  emptyWebhookRemark?: boolean;
  startAt?: string;
  endAt?: string;
}

export async function fetchPushLogStats(params: Pick<PushLogListParams, 'startAt' | 'endAt'> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  if (params.startAt) search.set('startAt', params.startAt);
  if (params.endAt) search.set('endAt', params.endAt);
  return requestJson<Record<string, unknown>>('GET', `/api/push-log/stats?${search}`, { signal });
}

export async function fetchPushLog(
  params: PushLogListParams = {},
  signal?: AbortSignal,
): Promise<{ items: unknown[]; total: number }> {
  const search = new URLSearchParams();
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  if (params.search) search.set('search', params.search);
  if (params.status) search.set('status', params.status);
  if (params.source) search.set('source', params.source);
  if (params.webhookRemark) search.set('webhookRemark', params.webhookRemark);
  if (params.emptyWebhookRemark) search.set('emptyWebhookRemark', 'true');
  if (params.startAt) search.set('startAt', params.startAt);
  if (params.endAt) search.set('endAt', params.endAt);
  return requestJson('GET', `/api/push-log?${search}`, { signal });
}
