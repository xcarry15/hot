import { fetchSafe, readResponseText } from '@/lib/http';
import { withTimeout } from '@/lib/shared/async';

function parseError(body: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const error = (payload as Record<string, unknown>).error;
    return error && typeof error === 'object' && !Array.isArray(error)
      ? error as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 仅匹配已知错误并返回固定文案，不暴露 Google 原始响应或 Key。 */
export function getGeminiConfigurationError(body: string): string | null {
  const error = parseError(body);
  if (!error) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  const details = Array.isArray(error.details) ? error.details : [];
  const reasons = details.flatMap((detail) => (
    detail && typeof detail === 'object' && typeof detail.reason === 'string' ? [detail.reason] : []
  )).join(' ');
  const signal = `${reasons} ${message}`;
  if (/API_KEY_INVALID|API_KEY_EXPIRED|API key not valid|API key expired|API key.{0,40}leaked/i.test(signal)) {
    return 'Gemini API Key 无效、过期或已被停用，请在 Google AI Studio 检查';
  }
  if (/user location is not supported|not available in your country|unsupported_country/i.test(signal)) {
    return 'Gemini 不支持当前服务所在地区，请核对 Google 支持的地区和服务出站配置';
  }
  if (/free tier is not available|billing.{0,60}(not enabled|enable|required)/i.test(signal)) {
    return '当前 Google 项目无法使用免费层，请在 AI Studio 核对地区、额度与计费设置';
  }
  if (/SERVICE_DISABLED|API has not been used|API.{0,50}has not been enabled/i.test(signal)) {
    return 'Google 项目尚未启用 Gemini API，请检查项目服务权限';
  }
  if (error.status === 'NOT_FOUND') {
    return '当前 Gemini 模型不存在或此 Key 无权调用，请刷新模型列表后重新选择';
  }
  return null;
}

export function getGeminiRetryAfterMs(body: string): number | undefined {
  const details = parseError(body)?.details;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || detail['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const match = typeof detail.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
    if (match) return Math.min(24 * 60 * 60 * 1000, Number(match[1]) * 1000);
  }
  return undefined;
}

export class GeminiModelsError extends Error {}

/** 使用固定官方地址和请求头鉴权，避免将 Key 写入 URL、浏览器缓存或日志。 */
export async function fetchGeminiModelIds(apiKey: string): Promise<string[]> {
  return withTimeout(async (signal) => {
    const ids = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetchSafe(url.toString(), {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'x-goog-api-key': apiKey },
        signal,
      });
      const body = await readResponseText(response, 1024 * 1024);
      if (!response.ok) {
        throw new GeminiModelsError(getGeminiConfigurationError(body) || `Gemini 模型列表请求失败（${response.status}），请检查已保存的 Key、额度或网络`);
      }
      const payload: unknown = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GeminiModelsError('Gemini 模型列表格式无效');
      const data = payload as { models?: unknown; nextPageToken?: unknown };
      if (!Array.isArray(data.models)) throw new GeminiModelsError('Gemini 模型列表格式无效');
      for (const item of data.models) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const model = item as { name?: unknown; supportedGenerationMethods?: unknown };
        if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes('generateContent')) continue;
        const id = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '';
        if (!/^gemini-[a-zA-Z0-9._-]{1,120}$/.test(id)) continue;
        if (/(?:^|-)(?:image|audio|tts|live|embedding|transcribe|computer-use|robotics|deep-research|customtools)(?:-|$)/i.test(id)) continue;
        ids.add(id);
      }
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken) {
        if (ids.size === 0) throw new GeminiModelsError('当前 Key 未返回兼容的 Gemini 文本模型，已保留内置候选');
        return [...ids];
      }
    }
    throw new GeminiModelsError('Gemini 模型目录分页过多，请稍后重试');
  }, 10_000, 'Gemini 模型列表请求超时');
}
