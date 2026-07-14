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

export async function fetchSettings(signal?: AbortSignal): Promise<SettingsMap> {
  return requestJson<SettingsMap>('GET', '/api/settings', { signal });
}

export async function saveSettings(
  patch: SettingsMap,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson('PUT', '/api/settings', { body: patch, signal });
}

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

export interface ScorePreviewInput { weightEvent: number; weightContent: number }
export interface ScorePreviewResult { total: number; changed: number; increased: number; decreased: number; samples: { id: string; title: string; before: number; after: number; delta: number }[] }
export async function previewScoreSettings(input: ScorePreviewInput, signal?: AbortSignal): Promise<ScorePreviewResult> {
  return requestJson<ScorePreviewResult>('POST', '/api/settings', {
    body: { action: 'score-preview', ...input },
    signal,
  });
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
