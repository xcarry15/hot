import type { EventDetailDto, EventSearchOptionDto } from '@/contracts/events';
import { requestJson } from '@/lib/request-json.client';

export type EventPushMode = 'manual' | 'repush';

export function fetchEventDetail(
  eventId: string,
  articleId?: string,
  signal?: AbortSignal,
): Promise<EventDetailDto> {
  const params = new URLSearchParams();
  if (articleId) params.set('articleId', articleId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return requestJson<EventDetailDto>('GET', `/api/events/${encodeURIComponent(eventId)}${query}`, { signal });
}

export function searchActiveEvents(
  query: string,
  excludeEventId: string,
  signal?: AbortSignal,
): Promise<EventSearchOptionDto[]> {
  const params = new URLSearchParams({ q: query, excludeEventId });
  return requestJson<EventSearchOptionDto[]>('GET', `/api/events/search?${params.toString()}`, { signal });
}

export async function updateEventRepresentative(eventId: string, articleId: string): Promise<void> {
  await requestJson('PATCH', `/api/events/${encodeURIComponent(eventId)}`, {
    body: { representativeArticleId: articleId },
  });
}

export async function splitEventArticles(eventId: string, articleIds: string[]): Promise<void> {
  await requestJson('POST', `/api/events/${encodeURIComponent(eventId)}/split`, {
    body: { articleIds },
  });
}

export async function mergeEvents(sourceEventId: string, targetEventId: string): Promise<void> {
  await requestJson('POST', '/api/events/merge', {
    body: { sourceEventId, targetEventId },
  });
}

export async function moveEventArticle(eventId: string, articleId: string, targetEventId: string): Promise<void> {
  await requestJson('POST', `/api/events/${encodeURIComponent(eventId)}/move`, {
    body: { articleId, targetEventId },
  });
}

export async function confirmEventIndependent(eventId: string, articleId: string): Promise<void> {
  await requestJson('POST', `/api/events/${encodeURIComponent(eventId)}/confirm-independent`, {
    body: { articleId },
  });
}

export function pushEvent(
  eventId: string,
  mode: EventPushMode,
): Promise<{ message?: string }> {
  return requestJson<{ message?: string }>('POST', `/api/events/${encodeURIComponent(eventId)}/push`, {
    body: { mode },
  });
}
