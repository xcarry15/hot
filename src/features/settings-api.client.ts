/**
 * Settings feature 的客户端 API 层。
 *
 * 涵盖：
 *   - settings 读写（GET /api/settings、PUT /api/settings、/api/settings/reveal 解密）
 *   - AI 模型测试（POST /api/settings/test-ai）
 *   - Webhook 测试（POST /api/settings/test-webhook）
 *
 * 与 maintenance-api.client 协同：data.tsx 同时承担导入导出 + 清理操作。
 */
import { requestJson } from '@/lib/request-json.client';

/** Settings 行级 key→value 映射：与前端 Settings interface 一致。 */
export type SettingsMap = Record<string, string>;

const SETTINGS_CHANGED_EVENT = 'hot2-settings-changed';
const LIVE_SETTING_KEYS = ['auto_crawl_enabled', 'crawl_interval_min'] as const;
type LiveSettingKey = typeof LIVE_SETTING_KEYS[number];
export type LiveSettingsPatch = Partial<Record<LiveSettingKey, string>>;

function getLiveSettingsPatch(patch: SettingsMap): LiveSettingsPatch {
  const changes: LiveSettingsPatch = {};
  for (const key of LIVE_SETTING_KEYS) {
    if (typeof patch[key] === 'string') changes[key] = patch[key];
  }
  return changes;
}

export function subscribeToSettingsChanged(listener: (changes: LiveSettingsPatch) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<{ changes?: LiveSettingsPatch }>).detail;
    if (detail?.changes && Object.keys(detail.changes).length > 0) listener(detail.changes);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, handleChange);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handleChange);
}

function publishSettingsChanged(patch: SettingsMap): void {
  if (typeof window === 'undefined') return;
  const changes = getLiveSettingsPatch(patch);
  if (Object.keys(changes).length === 0) return;
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { changes } }));
}

export async function fetchSettings(signal?: AbortSignal): Promise<SettingsMap> {
  return requestJson<SettingsMap>('GET', '/api/settings', { signal });
}

export interface OpenCodeModelsResult {
  models: string[];
}

export async function fetchOpenCodeModels(signal?: AbortSignal): Promise<OpenCodeModelsResult> {
  return requestJson<OpenCodeModelsResult>('GET', '/api/settings/opencode-models', { signal });
}

export async function saveSettings(
  patch: SettingsMap,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await requestJson('PUT', '/api/settings', { body: patch, signal });
  publishSettingsChanged(patch);
  return result;
}

export interface SettingsSaveResult { ok: true; scoreRecomputed?: number; publicationRebuilt?: boolean; success?: boolean }

/**
 * 解密指定敏感字段。服务端仍会以 SENSITIVE_SETTING_KEYS 做白名单过滤，
 * 避免进入某个编辑页时把无关密钥一并发送到浏览器。
 */
export async function revealSettings(
  keys: string[] = [],
  signal?: AbortSignal,
): Promise<SettingsMap> {
  return requestJson<SettingsMap>('POST', '/api/settings/reveal', {
    body: keys.length > 0 ? { keys } : undefined,
    signal,
  });
}

/**
 * 设置导出：返回完整 payload（含明文密钥），用于下载为 JSON。
 * 返回结构：{ type, version, exportedAt, settings: SettingsMap }。
 */
export interface SettingsExportPayload {
  type: string;
  version: number;
  exportedAt: string;
  settings: SettingsMap;
}
export async function exportSettings(signal?: AbortSignal): Promise<SettingsExportPayload> {
  return requestJson<SettingsExportPayload>('POST', '/api/settings/export', { signal });
}

export interface AiTestResult {
  success: boolean;
  provider?: string;
  model?: string;
  error?: string;
  responsePreview?: string;
}

export interface AiTestInput {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export async function testAiSettings(input: AiTestInput, signal?: AbortSignal): Promise<AiTestResult> {
  return requestJson<AiTestResult>('POST', '/api/settings/test-ai', { body: input, signal });
}

export interface ScorePreviewInput { weightEvent: number; weightContent: number; keywordBonus: number }
export interface ScorePreviewResult { total: number; changed: number; increased: number; decreased: number; samples: { id: string; title: string; before: number; after: number; delta: number }[] }
export async function previewScoreSettings(input: ScorePreviewInput, signal?: AbortSignal): Promise<ScorePreviewResult> {
  return requestJson<ScorePreviewResult>('POST', '/api/settings', {
    body: { action: 'score-preview', ...input },
    signal,
  });
}

export interface PublicPreviewResult { candidates: number; eligible: number; wouldPublish: number; wouldHide: number; minScore: number; minRelevance: number; hideAds: boolean }
export interface PushPreviewResult { pushMode: string; pushable: number; webhookCount: number; willPush: number }
export async function previewPushSettings(input: { minScore: number; minRelevance: number; pushMode: string }, signal?: AbortSignal): Promise<PushPreviewResult> {
  return requestJson('POST', '/api/settings', { body: { action: 'push-preview', ...input }, signal });
}

export async function previewPublicSettings(input: { minScore: number; minRelevance: number; hideAds: boolean }, signal?: AbortSignal): Promise<PublicPreviewResult> {
  return requestJson('POST', '/api/settings', { body: { action: 'public-preview', ...input }, signal });
}

export interface WebhookTestResultDto {
  success: boolean;
  error?: string;
}

export async function testWebhook(
  webhookUrl: string,
  signal?: AbortSignal,
): Promise<WebhookTestResultDto> {
  return requestJson<WebhookTestResultDto>('POST', '/api/settings/test-webhook', {
    body: { webhookUrl: webhookUrl.trim() },
    signal,
  });
}
