/**
 * Unified AI Client — chat completions only.
 *
 * Supported providers (OpenAI-compatible):
 *   opencode (default, free) | deepseek
 *
 * The ZAI SDK is NOT used for chat. It is imported separately by `parser-html.ts`
 * and `crawler.ts` for `page_reader` / `web_search` (see `./zai`).
 *
 * Settings stored in DB (Setting table):
 *   ai_provider  — opencode | deepseek
 *   {provider}_api_key / {provider}_base_url / {provider}_model
 *   ai_temperature — Temperature (0-2; default from settings catalog)
 *   ai_max_tokens  — Max tokens (1-65536; default from settings catalog)
 */

import { createCache } from './cache';
import { readAllSettings, SETTING_KEYS } from './settings';
import { getSettingDefinition } from './settings-catalog';
import { abortableDelay, withTimeout } from './shared/async';
import { AI_PROVIDERS, providerSettingKey } from '@/contracts/ai-provider';
import type { AIProviderId } from '@/contracts/ai-provider';

export { AI_PROVIDERS, providerSettingKey } from '@/contracts/ai-provider';
export type { AIProviderId } from '@/contracts/ai-provider';

export type AIErrorKind = 'configuration' | 'rate_limit' | 'provider' | 'network' | 'timeout' | 'content';

export class AIClientError extends Error {
  constructor(message: string, public readonly kind: AIErrorKind, public readonly global: boolean, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = 'AIClientError';
  }
}

const providerBreakers = new Map<AIProviderId, { failures: number; openUntil: number; reason: string }>();
const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_OPEN_MS = 5 * 60_000;

function assertProviderAvailable(provider: AIProviderId): void {
  const state = providerBreakers.get(provider);
  if (state && state.openUntil > Date.now()) throw new AIClientError(`${provider}: 服务熔断中（${state.reason}）`, 'provider', true, true);
}

function recordProviderSuccess(provider: AIProviderId): void { providerBreakers.delete(provider); }

function recordProviderFailure(provider: AIProviderId, reason: string, forceOpen = false): void {
  const failures = (providerBreakers.get(provider)?.failures ?? 0) + 1;
  providerBreakers.set(provider, { failures, reason, openUntil: forceOpen || failures >= BREAKER_FAILURE_THRESHOLD ? Date.now() + BREAKER_OPEN_MS : 0 });
}

/**
 * Clamp 打分权重字符串值到 [0,100] 整数,非法/空值用 fallback。
 */
function clampWeight(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

// ── Settings cache ────────────────────────────────────────────────
export interface AISettings {
  provider: AIProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  /** 单次分析评判块（块化组合，空串=用默认块） */
  blockAd: string;
  blockEventScore: string;
  blockCategory: string;
  blockRelevance: string;
  blockContentScore: string;
  blockKeyPoints: string;
  blockSummary: string;
  blockEventIdentity: string;
  blockBrand: string;
  /** 打分权重(动态可调) */
  weightEvent: number;
  weightContent: number;
  keywordMatchBonus: number;
  /** AI 正文最大字符数 */
  step2ContentMaxChars: number;
}

// 默认打分权重：事件影响为主，内容可用性为辅。
function numericSettingDefault(key: string, fallback: number): number {
  const value = Number(getSettingDefinition(key)?.defaultValue);
  return Number.isFinite(value) ? value : fallback;
}

// 默认值来自统一配置目录；fallback 只用于目录损坏时保持客户端可运行。
const DEFAULT_WEIGHT_EVENT = numericSettingDefault(SETTING_KEYS.AI_WEIGHT_EVENT, 70);
const DEFAULT_WEIGHT_CONTENT = numericSettingDefault(SETTING_KEYS.AI_WEIGHT_CONTENT, 30);
const DEFAULT_TEMPERATURE = numericSettingDefault(SETTING_KEYS.AI_TEMPERATURE, 0.3);
const DEFAULT_MAX_TOKENS = numericSettingDefault(SETTING_KEYS.AI_MAX_TOKENS, 10240);
const DEFAULT_STEP2_CONTENT_MAX_CHARS = numericSettingDefault(SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS, 5000);

const settingsCache = createCache<AISettings>(30_000); // 30 seconds

export async function getAISettings(): Promise<AISettings> {
  const cached = settingsCache.get();
  if (cached) return cached;

  const map = await readAllSettings();

  const requestedProvider = map[SETTING_KEYS.AI_PROVIDER];
  const defaultProvider = Object.keys(AI_PROVIDERS)[0] as AIProviderId;
  const provider: AIProviderId = requestedProvider && requestedProvider in AI_PROVIDERS
    ? requestedProvider as AIProviderId
    : defaultProvider;
  const providerDef = AI_PROVIDERS[provider];
  const rawTemperature = map[SETTING_KEYS.AI_TEMPERATURE]?.trim();
  const parsedTemperature = rawTemperature ? Number(rawTemperature) : Number.NaN;
  const temperature = Number.isFinite(parsedTemperature)
    ? Math.max(0, Math.min(2, parsedTemperature))
    : DEFAULT_TEMPERATURE;

  const apiKey = map[providerSettingKey(provider, 'api_key')] ?? '';
  const baseUrl = map[providerSettingKey(provider, 'base_url')] || providerDef.baseUrl;
  const model = map[providerSettingKey(provider, 'model')] || providerDef.defaultModel;

  const resolved: AISettings = {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature,
    maxTokens: Math.max(1, Math.min(65536, parseInt(map[SETTING_KEYS.AI_MAX_TOKENS]) || DEFAULT_MAX_TOKENS)),
    systemPrompt: map[SETTING_KEYS.AI_SYSTEM_PROMPT],
    blockAd: map.ai_block_ad,
    blockEventScore: map.ai_block_event_score,
    blockCategory: map.ai_block_category,
    blockRelevance: map.ai_block_relevance,
    blockContentScore: map.ai_block_content_score,
    blockKeyPoints: map.ai_block_key_points,
    blockSummary: map.ai_block_summary,
    blockEventIdentity: map.ai_block_event_identity,
    blockBrand: map.ai_block_brand,
    weightEvent: clampWeight(map[SETTING_KEYS.AI_WEIGHT_EVENT], DEFAULT_WEIGHT_EVENT),
    weightContent: clampWeight(map[SETTING_KEYS.AI_WEIGHT_CONTENT], DEFAULT_WEIGHT_CONTENT),
    keywordMatchBonus: Math.max(0, Math.min(20, parseInt(map[SETTING_KEYS.AI_KEYWORD_MATCH_BONUS]) || 0)),
    step2ContentMaxChars: Math.max(500, Math.min(10000, parseInt(map[SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS]) || DEFAULT_STEP2_CONTENT_MAX_CHARS)),
  };
  settingsCache.set(resolved);

  return resolved;
}

export function invalidateAISettingsCache(): void {
  settingsCache.invalidate();
  // 修改 API Key / Provider 后允许立即重新探测，不让旧熔断状态阻塞修复验证。
  providerBreakers.clear();
}

// ── Chat Completion Types ─────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  provider: AIProviderId;
  model: string;
}

export type ChatResponseFormat = 'json_object';

// ── Unified Chat Completion ───────────────────────────────────────

/**
 * Create a chat completion using the configured provider.
 * Both supported providers use OpenAI-compatible APIs.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; responseFormat?: ChatResponseFormat; signal?: AbortSignal }
): Promise<ChatCompletionResponse> {
  const settings = await getAISettings();
  assertProviderAvailable(settings.provider);

  const finalOptions = {
    temperature: options?.temperature ?? settings.temperature,
    maxTokens: options?.maxTokens ?? settings.maxTokens,
  };

  return createOpenAICompatibleCompletion(settings, messages, {
    ...finalOptions,
    responseFormat: options?.responseFormat,
  }, 2, options?.signal);
}

/**
 * OpenAI-compatible API completion (opencode, deepseek)
 * Includes retry with backoff for 429 errors and network failures.
 */
async function createOpenAICompatibleCompletion(
  settings: AISettings,
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number; responseFormat?: ChatResponseFormat },
  retries = 2,
  parentSignal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: settings.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    ...(options.responseFormat === 'json_object'
      ? { response_format: { type: 'json_object' } }
      : {}),
  };

  // OpenCode free models can be slower; give them a longer timeout
  const timeoutMs = settings.provider === 'opencode' ? 60_000 : 15_000;

  console.log(`[ai-client] Calling ${settings.provider}: POST ${url} model=${settings.model}`);

  let lastError: { status: number; message: string } | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: { ok: boolean; status: number; bodyText: string };
    try {
      response = await withTimeout(async signal => {
        const rawResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        const bodyText = await rawResponse.text();
        return { ok: rawResponse.ok, status: rawResponse.status, bodyText };
      }, timeoutMs, `${settings.provider} request timeout`, parentSignal);
    } catch (fetchError) {
      if (parentSignal?.aborted) throw fetchError;
      const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);

      // 网络错误/超时：记录并重试（不直接抛错）
      if (attempt < retries) {
        const isAbort = /timeout|aborted|aborterror/i.test(errMsg);
        const isNetworkError = /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(errMsg);
        if (isAbort || isNetworkError) {
          const delayMs = Math.min(2000 * Math.pow(2, attempt), 10000);
          console.warn(`[ai-client] ${settings.provider} ${isAbort ? 'timeout' : 'network error'}, retry ${attempt + 1}/${retries} in ${delayMs}ms`);
          await abortableDelay(delayMs, parentSignal);
          continue;
        }
      }

      // 超过重试次数或不可重试的错误
      if (/timeout|aborted|aborterror/i.test(errMsg)) {
        recordProviderFailure(settings.provider, '请求超时');
        throw new AIClientError(`${settings.provider}: 请求超时(${timeoutMs / 1000}s)`, 'timeout', true, true);
      }
      if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(errMsg)) {
        recordProviderFailure(settings.provider, '网络连接失败');
        throw new AIClientError(`${settings.provider}: 无法连接 API 服务器`, 'network', true, true);
      }
      throw new AIClientError(`${settings.provider}: 请求失败 - ${errMsg.substring(0, 200)}`, 'network', true, true);
    }
    if (response.ok) {
      const data = JSON.parse(response.bodyText || '{}');
      const content = data?.choices?.[0]?.message?.content || '';

      if (!content) {
        console.warn(`[ai-client] ${settings.provider} returned empty content. Response:`, JSON.stringify(data).substring(0, 300));
      }

      recordProviderSuccess(settings.provider);
      return {
        content,
        provider: settings.provider,
        model: settings.model,
      };
    }

    const errorText = response.bodyText;
    console.error(`[ai-client] ${settings.provider} API error (${response.status}): ${errorText.substring(0, 500)}`);

    lastError = { status: response.status, message: errorText.substring(0, 200) };

    // 部分 OpenAI 兼容网关不实现 response_format：去掉可选参数重试，
    // 但上层仍会执行严格 JSON 解析和 Schema 校验。
    if (response.status === 400 && body.response_format && /response[_ -]?format|json_object|unsupported/i.test(errorText)) {
      delete body.response_format;
      console.warn(`[ai-client] ${settings.provider} 不支持 response_format，降级为严格客户端校验`);
      continue;
    }

    // 429 与 5xx 服务端错误：指数退避重试
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const isRateLimit = response.status === 429;
      const baseDelay = Math.min(isRateLimit ? 3000 : 2000 * Math.pow(2, attempt), 15000);
      const jitter = isRateLimit ? Math.floor(Math.random() * 1000) : 0;
      const delayMs = baseDelay + jitter;
      console.warn(`[ai-client] ${settings.provider} ${response.status} ${isRateLimit ? 'rate limit' : 'server error'}, retry ${attempt + 1}/${retries} in ${delayMs}ms`);
      await abortableDelay(delayMs, parentSignal);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      recordProviderFailure(settings.provider, '鉴权失败', true);
      throw new AIClientError(`${settings.provider}: API Key 无效或鉴权失败`, 'configuration', true, false, response.status);
    }

    if (response.status === 402) {
      recordProviderFailure(settings.provider, '余额不足', true);
      throw new AIClientError(`${settings.provider}: 账户余额不足，请前往平台充值`, 'configuration', true, false, response.status);
    }

    break;
  }

  // 根据最后一次错误抛出真实原因，避免固定文案误导用户
  if (lastError) {
    if (lastError.status === 429) {
      recordProviderFailure(settings.provider, '请求频率超限');
      throw new AIClientError(`${settings.provider}: 请求频率超限，请稍后重试`, 'rate_limit', true, true, 429);
    }
    if (lastError.status >= 500) {
      recordProviderFailure(settings.provider, `服务错误 ${lastError.status}`);
      throw new AIClientError(`${settings.provider}: 服务暂不可用(${lastError.status})`, 'provider', true, true, lastError.status);
    }
    recordProviderFailure(settings.provider, `API 错误 ${lastError.status}`);
    throw new AIClientError(
      `${settings.provider} API 错误 (${lastError.status}): ${lastError.message}`,
      'provider',
      true,
      false,
      lastError.status,
    );
  }

  recordProviderFailure(settings.provider, '达到最大重试次数');
  throw new AIClientError(`${settings.provider}: 请求失败，已达到最大重试次数`, 'provider', true, true);
}

/**
 * Test the AI connection with a simple prompt.
 */
export async function testAIConnection(overrides?: Partial<Pick<AISettings, 'provider' | 'apiKey' | 'baseUrl' | 'model' | 'temperature' | 'maxTokens'>>): Promise<{
  success: boolean;
  provider: string;
  model: string;
  error?: string;
  responsePreview?: string;
}> {
  const saved = await getAISettings();
  const settings = {
    ...saved,
    ...overrides,
    // 未获 reveal 权限时前端看见的是空串；测试应继续使用数据库中的现有密钥。
    apiKey: overrides?.apiKey || saved.apiKey,
  };

  try {
    if (!settings.apiKey) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写 API Key',
      };
    }
    if (!settings.baseUrl) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写 API 地址',
      };
    }
    if (!settings.model) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写模型名称',
      };
    }

    const result = await createOpenAICompatibleCompletion(settings, [
      { role: 'user', content: '请回复"连接成功"' },
    ], { temperature: 0.7, maxTokens: 100 });

    return {
      success: true,
      provider: result.provider,
      model: result.model,
      responsePreview: result.content.substring(0, 100),
    };
  } catch (error) {
    let errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (/429/.test(errorMsg) || /too many requests/i.test(errorMsg)) {
      errorMsg = '请求频率超限，请稍后重试';
    } else if (/timeout/i.test(errorMsg) || /ETIMEDOUT/i.test(errorMsg)) {
      errorMsg = '请求超时，请检查网络连接';
    }
    return {
      success: false,
      provider: settings.provider,
      model: settings.model,
      error: errorMsg,
    };
  }
}
