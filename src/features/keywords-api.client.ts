/**
 * Keyword feature 的客户端 API 层。
 *
 * 字段形状由 server 决定；本文件不锁定具体 schema，由调用方 narrow。
 */
import { requestJson } from '@/lib/request-json.client';
import { getApiToken } from '@/lib/api-client';

export interface Keyword {
  id: string;
  category: string;
  word: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface KeywordListParams {
  search?: string;
  category?: string;
}

export interface KeywordCandidate {
  id: string;
  phrase: string;
  occurrences: number;
  sampleTitles: string[];
  sourceCount: number;
  recallCount: number;
}

export async function fetchKeywordCandidates(signal?: AbortSignal): Promise<KeywordCandidate[]> {
  return requestJson<KeywordCandidate[]>('GET', '/api/keywords?candidates=true', { signal });
}

export async function updateKeywordCandidate(
  id: string,
  action: 'approve-candidate' | 'dismiss-candidate',
  signal?: AbortSignal,
): Promise<{ restored: number; processQueued: boolean; restoreLimit: number }> {
  return requestJson('POST', '/api/keywords', { body: { id, action }, signal });
}

export async function fetchKeywords(
  params: KeywordListParams = {},
  signal?: AbortSignal,
): Promise<Keyword[]> {
  const search = new URLSearchParams();
  if (params.search) search.set('search', params.search);
  if (params.category) search.set('category', params.category);
  return requestJson<Keyword[]>('GET', `/api/keywords${search.toString() ? `?${search}` : ''}`, { signal });
}

export async function deleteKeyword(
  id: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('DELETE', `/api/keywords?id=${id}`, { signal });
}

export async function bulkClearKeywords(signal?: AbortSignal): Promise<{ deleted: number }> {
  return requestJson<{ deleted: number }>('PUT', '/api/keywords', { body: { action: 'clear-all' }, signal });
}

export async function bulkAddKeywords(
  text: string,
  signal?: AbortSignal,
): Promise<{ imported?: number; skipped?: number; error?: string }> {
  return requestJson('POST', '/api/keywords', { body: { text }, signal });
}

export async function importKeywordsXlsx(
  file: Blob,
  signal?: AbortSignal,
): Promise<{ imported: number; skipped: number; importedCandidates: number; skippedCandidates: number; restored: number; processQueued: boolean }> {
  const token = getApiToken();
  const res = await fetch('/api/keywords', {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as { imported: number; skipped: number; importedCandidates: number; skippedCandidates: number; restored: number; processQueued: boolean };
}

export async function exportKeywordsXlsxBlob(signal?: AbortSignal): Promise<Blob> {
  // XLSX is a raw binary blob; use plain fetch for the Blob body
  const token = getApiToken();
  const res = await fetch('/api/keywords?format=xlsx', {
    signal,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
