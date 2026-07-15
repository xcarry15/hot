/**
 * Source feature 的客户端 API 层。
 *
 * 组件不再直接 fetch；endpoint 拼装 + JSON / 错误 / AbortSignal 全部收敛到这里。
 * 类型契约来自 contracts，不依赖组件目录。
 */
import { requestJson } from '@/lib/request-json.client';
import type { SourceDto, SourceTestResultDto } from '@/contracts/sources';

export async function fetchSources(signal?: AbortSignal): Promise<SourceDto[]> {
  return requestJson<SourceDto[]>('GET', '/api/sources', { signal });
}

export interface SourceInput {
  name: string;
  type: string;
  url: string;
  parserConfig: string;
  enabled: boolean;
  publicEnabled?: boolean;
}

export async function createSource(
  input: SourceInput,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/sources', { body: input, signal });
}

export async function updateSource(
  id: string,
  patch: Partial<SourceInput>,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('PUT', `/api/sources/${id}`, { body: patch, signal });
}

export async function deleteSource(
  id: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('DELETE', `/api/sources/${id}`, { signal });
}

export async function testSource(
  input: { type: string; url: string; parserConfig: string },
  signal?: AbortSignal,
): Promise<SourceTestResultDto> {
  return requestJson<SourceTestResultDto>('POST', '/api/sources/test', { body: input, signal });
}

export async function batchToggleSources(
  enabled: boolean,
  signal?: AbortSignal,
): Promise<{ updated: number }> {
  return requestJson<{ updated: number }>('POST', '/api/sources/batch-toggle', {
    body: { enabled },
    signal,
  });
}

export async function retrySource(
  sourceId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/sources/retry', { body: { sourceId }, signal });
}

/* ── Preset sources ────────────────────────────────────────────── */

export interface PresetSource {
  id: string;
  name: string;
  type: string;
  url: string;
  parserConfig: string;
  category: string;
  description: string;
  isAdded: boolean;
  [key: string]: unknown;
}

export type AddPresetSourcePayload =
  | { presetIds: string[] }
  | { addAll: true }

export async function fetchPresetSources(
  signal?: AbortSignal,
): Promise<PresetSource[]> {
  return requestJson<PresetSource[]>('GET', '/api/sources/presets', { signal });
}

export async function addPresetSource(
  payload: AddPresetSourcePayload,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('POST', '/api/sources/presets', { body: payload, signal });
}
