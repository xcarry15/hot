/**
 * Unified AI Client — OpenAI-compatible Chat Completions / Responses.
 *
 * Supported providers (OpenAI-compatible):
 *   opencode (default, free) | deepseek | openrouter (free routing)
 *
 * The ZAI SDK is NOT used for chat. It is imported separately by `parser-html.ts`
 * and `crawler.ts` for `page_reader` / `web_search` (see `./zai`).
 *
 * Settings stored in DB (Setting table):
 *   ai_provider  — opencode | deepseek | openrouter
 *   {provider}_api_key / {provider}_base_url / {provider}_model
 *   ai_temperature — Temperature (0-2; default from settings catalog)
 *   ai_max_tokens  — Max tokens (1-65536; default from settings catalog)
 */

import { createCache } from './cache';
import { readAllSettings, SETTING_KEYS } from './settings';
import { getSettingDefinition } from './settings-catalog';
import { abortableDelay, withTimeout } from './shared/async';
import { fetchSafe, readResponseText } from './http';
import { getAIRateLimitCooldownRemainingMs, noteAIRateLimit, waitForAIRequestSlot, isFreeAIModel } from './ai-rate-gate';
import { clearAIProviderBackoff, getAIProviderBackoff, noteAIProviderFailure } from './ai-provider-backoff';
import {
  AI_PROVIDERS,
  getOpenCodeModelProtocol,
  isOpenCodeFreeModel,
  isOpenRouterFreeModel,
  providerSettingKey,
} from '@/contracts/ai-provider';
import type { AIProviderId } from '@/contracts/ai-provider';

export { AI_PROVIDERS, providerSettingKey } from '@/contracts/ai-provider';
export type { AIProviderId } from '@/contracts/ai-provider';

export type AIErrorKind = 'configuration' | 'rate_limit' | 'provider' | 'network' | 'timeout' | 'content';

export class AIClientError extends Error {
  constructor(
    message: string,
    public readonly kind: AIErrorKind,
    public readonly global: boolean,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AIClientError';
  }
}

export interface AIConnectionTestResult {
  success: boolean;
  provider: string;
  model: string;
  error?: string;
  errorKind?: AIErrorKind;
  status?: number;
  retryAfterMs?: number;
  latencyMs?: number;
  responsePreview?: string;
}

export interface AIConnectionTestOptions {
  prompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  failFastOnRateLimit?: boolean;
}

function isArticleRequestError(status: number, message: string): boolean {
  if (status === 413 || status === 422) return true;
  if (status !== 400) return false;
  return /context length|maximum context|too many tokens|prompt.{0,20}(long|large)|messages?.{0,20}(long|large)|request.{0,20}too large/i.test(message);
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

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

async function buildProviderPayloadError(
  settings: AISettings,
  status: number,
  message: string,
  persistProviderFailures: boolean,
): Promise<AIClientError> {
  let retryAfterMs: number | undefined;
  if (persistProviderFailures) {
    try {
      const backoff = await noteAIProviderFailure(settings.provider, { kind: 'provider', status });
      retryAfterMs = Math.max(0, (backoff.cooldownUntil?.getTime() || 0) - Date.now());
    } catch (backoffError) {
      console.error('[ai-client] 持久化 Provider 退避状态失败', backoffError);
    }
  }
  return new AIClientError(message, 'provider', true, true, status, retryAfterMs);
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
const DEFAULT_MAX_TOKENS = numericSettingDefault(SETTING_KEYS.AI_MAX_TOKENS, 2048);
const DEFAULT_STEP2_CONTENT_MAX_CHARS = numericSettingDefault(SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS, 5000);
const AI_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const AI_HEALTH_TEST_TIMEOUT_MS = 12_000;
const AI_HEALTH_TEST_MAX_TOKENS = 16;

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
  const configuredModel = map[providerSettingKey(provider, 'model')]?.trim() || providerDef.defaultModel;
  // 免费 Provider 只开放免费模型。防止旧数据库或手工写入的付费模型
  // 绕过设置页校验后产生费用。
  const model = (provider === 'opencode' && !isOpenCodeFreeModel(configuredModel))
    || (provider === 'openrouter' && !isOpenRouterFreeModel(configuredModel))
    ? providerDef.defaultModel
    : configuredModel;

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

function toOpenAIResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'system') {
      return { role: 'system', content: message.content };
    }

    return {
      role: message.role,
      content: [{
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      }],
    };
  });
}

function extractResponsesContent(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const record = data as Record<string, unknown>;
  if (typeof record.output_text === 'string' && record.output_text) return record.output_text;

  if (!Array.isArray(record.output)) return '';
  const chunks: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === 'output_text' && typeof partRecord.text === 'string') {
        chunks.push(partRecord.text);
      }
    }
  }
  return chunks.join('');
}

// ── Unified Chat Completion ───────────────────────────────────────

/**
 * Create a chat completion using the configured provider.
 * Supported providers use OpenAI-compatible APIs.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; responseFormat?: ChatResponseFormat; signal?: AbortSignal }
): Promise<ChatCompletionResponse> {
  const settings = await getAISettings();

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
 * OpenAI-compatible API completion (opencode, deepseek, openrouter).
 * OpenCode 的 Responses 模型按官方端点单独编码。
 */
async function createOpenAICompatibleCompletion(
  settings: AISettings,
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number; responseFormat?: ChatResponseFormat; timeoutMs?: number; onRequestStart?: () => void; persistProviderFailures?: boolean },
  retries = 2,
  parentSignal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  if (!settings.apiKey.trim()) {
    throw new AIClientError(`${settings.provider}: 未填写 API Key`, 'configuration', true, false);
  }
  if (!settings.model.trim()) {
    throw new AIClientError(`${settings.provider}: 未填写模型名称`, 'configuration', true, false);
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(settings.baseUrl.trim());
  } catch {
    throw new AIClientError(`${settings.provider}: API 地址格式不正确`, 'configuration', true, false);
  }
  if (parsedBaseUrl.protocol !== 'https:' && parsedBaseUrl.protocol !== 'http:') {
    throw new AIClientError(`${settings.provider}: API 地址仅支持 HTTP(S)`, 'configuration', true, false);
  }
  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new AIClientError(`${settings.provider}: API 地址不能包含查询参数或片段`, 'configuration', true, false);
  }
  const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
  if (settings.provider === 'opencode' && !isOpenCodeFreeModel(settings.model)) {
    throw new AIClientError('opencode: 仅允许调用免费模型', 'configuration', true, false);
  }
  if (settings.provider === 'openrouter' && !isOpenRouterFreeModel(settings.model)) {
    throw new AIClientError('openrouter: 仅允许调用免费模型', 'configuration', true, false);
  }
  const useResponses = settings.provider === 'opencode'
    && getOpenCodeModelProtocol(settings.model) === 'responses';
  const url = `${baseUrl}/${useResponses ? 'responses' : 'chat/completions'}`;
  const isFreeModel = isFreeAIModel(settings.provider, settings.model);
  // 免费模型的失败请求也可能消耗额度；不要在 429 后继续自动重试。
  const effectiveRetries = isFreeModel ? 0 : retries;

  const persistedBackoff = await getAIProviderBackoff(settings.provider);
  const persistedCooldownMs = persistedBackoff?.cooldownUntil
    ? Math.max(0, persistedBackoff.cooldownUntil.getTime() - Date.now())
    : 0;
  if (persistedCooldownMs > 0) {
    const errorKind = persistedBackoff?.lastErrorKind === 'provider'
      ? 'provider'
      : persistedBackoff?.lastErrorKind === 'network'
        ? 'network'
        : 'rate_limit';
    throw new AIClientError(
      `${settings.provider}: Provider 冷却中，约 ${Math.max(1, Math.ceil(persistedCooldownMs / 60_000))} 分钟后重试`,
      errorKind,
      true,
      true,
      persistedBackoff?.lastStatus ?? (errorKind === 'provider' ? 503 : errorKind === 'rate_limit' ? 429 : undefined),
      persistedCooldownMs,
    );
  }

  const body: Record<string, unknown> = useResponses
    ? {
        model: settings.model,
        input: toOpenAIResponsesInput(messages),
        temperature: options.temperature,
        max_output_tokens: options.maxTokens,
        // Responses API 的结构化输出字段并非 Zen 免费模型的通用能力；
        // 这里依赖现有 prompt + 客户端 Schema 校验，避免发送不兼容参数。
      }
    : {
        model: settings.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        // 结构化输出由 Prompt + 客户端 Schema 校验保证，不发送可触发兼容重试的
        // response_format。这样不会因格式兼容问题额外发起请求。
      };

  // 正文分析 prompt 较长；DeepSeek 和 OpenRouter 免费路由首 token 可能超过 15 秒。
  // 单篇超时由 AI pipeline 记录为当前文章失败，不能因为一篇慢文章暂停整批。
  const timeoutMs = options.timeoutMs ?? (settings.provider === 'opencode'
    || settings.provider === 'deepseek'
    || settings.provider === 'openrouter'
    ? 60_000
    : 15_000);

  console.log(`[ai-client] Calling ${settings.provider}: POST ${url} model=${settings.model}`);

  let lastError: { status: number; message: string; retryAfterMs?: number } | null = null;

  for (
    let attempt = 0;
    attempt <= effectiveRetries;
    attempt++
  ) {
    let response: { ok: boolean; status: number; bodyText: string; headers: Headers };
    try {
      response = await withTimeout(async signal => {
        await waitForAIRequestSlot(settings.provider, settings.model, signal);
        options.onRequestStart?.();
        const rawResponse = await fetchSafe(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        const bodyText = await readResponseText(rawResponse);
        return { ok: rawResponse.ok, status: rawResponse.status, bodyText, headers: rawResponse.headers };
      }, timeoutMs, `${settings.provider} request timeout`, parentSignal);
    } catch (fetchError) {
      if (parentSignal?.aborted) throw fetchError;
      const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);

      // 网络错误重试；超时不重复发送同一个长 prompt，避免单篇请求占满批处理
      // 的总时限。超时会作为当前文章的可重试失败返回给 AI pipeline。
      if (attempt < effectiveRetries) {
        const isNetworkError = /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(errMsg);
        if (isNetworkError) {
          const delayMs = Math.min(2000 * Math.pow(2, attempt), 10000);
          console.warn(`[ai-client] ${settings.provider} network error, retry ${attempt + 1}/${retries} in ${delayMs}ms`);
          await abortableDelay(delayMs, parentSignal);
          continue;
        }
      }

      // 超过重试次数或不可重试的错误
      if (/timeout|aborted|aborterror/i.test(errMsg)) {
        throw new AIClientError(`${settings.provider}: 请求超时(${timeoutMs / 1000}s)`, 'timeout', false, true);
      }
      if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(errMsg)) {
        let retryAfterMs: number | undefined;
        if (options.persistProviderFailures !== false) {
          try {
            const backoff = await noteAIProviderFailure(settings.provider, { kind: 'network' });
            retryAfterMs = Math.max(0, (backoff.cooldownUntil?.getTime() || 0) - Date.now());
          } catch (backoffError) {
            console.error('[ai-client] 持久化 Provider 退避状态失败', backoffError);
          }
        }
        throw new AIClientError(`${settings.provider}: 无法连接 API 服务器`, 'network', true, true, undefined, retryAfterMs);
      }
      throw new AIClientError(`${settings.provider}: 请求失败 - ${errMsg.substring(0, 200)}`, 'network', false, true);
    }
    if (response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(response.bodyText || '{}') as unknown;
      } catch {
        throw await buildProviderPayloadError(
          settings,
          response.status,
          `${settings.provider}: API 返回无效 JSON`,
          options.persistProviderFailures !== false,
        );
      }
      const rawContent = useResponses
        ? extractResponsesContent(data)
        : data && typeof data === 'object' && !Array.isArray(data)
          ? (((data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content))
          : undefined;
      const content = typeof rawContent === 'string' ? rawContent : '';

      if (!content) {
        throw await buildProviderPayloadError(
          settings,
          response.status,
          `${settings.provider}: API 返回空响应`,
          options.persistProviderFailures !== false,
        );
      }

      if (options.persistProviderFailures !== false && (persistedBackoff?.failureCount || 0) > 0) {
        try {
          await clearAIProviderBackoff(settings.provider);
        } catch (clearError) {
          // 成功的上游响应不能因为清理历史退避失败而被误报成 AI 失败。
          console.error('[ai-client] 清理 Provider 退避状态失败', clearError);
        }
      }

      return {
        content,
        provider: settings.provider,
        model: settings.model,
      };
    }

    const errorText = response.bodyText;
    console.error(`[ai-client] ${settings.provider} API error (${response.status}): ${errorText.substring(0, 500)}`);

    const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers) : undefined;
    if (response.status === 429) {
      noteAIRateLimit(settings.provider, settings.model, retryAfterMs);
    }
    lastError = { status: response.status, message: errorText.substring(0, 200), retryAfterMs };

    // 429 与 5xx 服务端错误：先完成本次调用的有限重试；最终失败后统一写入
    // Provider 冷却，避免把较长的持久化冷却塞进单篇请求超时。
    if ((response.status === 429 || response.status >= 500) && attempt < effectiveRetries) {
      const isRateLimit = response.status === 429;
      const baseDelay = Math.min(isRateLimit ? 10_000 * Math.pow(2, attempt) : 2000 * Math.pow(2, attempt), 30_000);
      const jitter = isRateLimit ? Math.floor(Math.random() * 1000) : 0;
      const delayMs = isRateLimit && retryAfterMs
        ? retryAfterMs
        : baseDelay + jitter;
      console.warn(`[ai-client] ${settings.provider} ${response.status} ${isRateLimit ? 'rate limit' : 'server error'}, retry ${attempt + 1}/${effectiveRetries} in ${delayMs}ms`);
      await abortableDelay(delayMs, parentSignal);
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && options.persistProviderFailures !== false) {
      try {
        const backoff = await noteAIProviderFailure(settings.provider, {
          kind: response.status === 429 ? 'rate_limit' : 'provider',
          status: response.status,
          retryAfterMs,
        });
        lastError.retryAfterMs = Math.max(
          lastError.retryAfterMs || 0,
          Math.max(0, (backoff.cooldownUntil?.getTime() || 0) - Date.now()),
        );
      } catch (backoffError) {
        // 退避记录失败时保留真实的 Provider 错误；队列仍使用默认退避继续保护上游。
        console.error('[ai-client] 持久化 Provider 退避状态失败', backoffError);
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIClientError(`${settings.provider}: API Key 无效或鉴权失败`, 'configuration', true, false, response.status);
    }

    if (response.status === 402) {
      throw new AIClientError(`${settings.provider}: 账户余额不足，请前往平台充值`, 'configuration', true, false, response.status);
    }

    break;
  }

  // 根据最后一次错误抛出真实原因，避免固定文案误导用户
  if (lastError) {
    if (lastError.status === 429) {
      throw new AIClientError(
        `${settings.provider}: 请求频率超限，请稍后重试`,
        'rate_limit',
        true,
        true,
        429,
        lastError.retryAfterMs,
      );
    }
    if (lastError.status >= 500) {
      throw new AIClientError(
        `${settings.provider}: 服务暂不可用(${lastError.status})`,
        'provider',
        true,
        true,
        lastError.status,
        lastError.retryAfterMs,
      );
    }
    // 请求体/上下文导致的 4xx 只影响当前文章。若误判为全局 Provider 故障，
    // 最老的一篇异常文章会在每次批处理开头暂停整个队列，使后续新文章饥饿。
    if (isArticleRequestError(lastError.status, lastError.message)) {
      throw new AIClientError(
        `${settings.provider} API 错误 (${lastError.status}): ${lastError.message}`,
        'content',
        false,
        false,
        lastError.status,
      );
    }
    throw new AIClientError(
      `${settings.provider} API 错误 (${lastError.status}): ${lastError.message}`,
      'provider',
      true,
      false,
      lastError.status,
    );
  }

  throw new AIClientError(`${settings.provider}: 请求失败，已达到最大重试次数`, 'provider', true, true);
}

/**
 * Test the AI connection with a simple prompt.
 */
export async function testAIConnection(
  overrides?: Partial<Pick<AISettings, 'provider' | 'apiKey' | 'baseUrl' | 'model' | 'temperature' | 'maxTokens'>>,
  options: AIConnectionTestOptions = {},
): Promise<AIConnectionTestResult> {
  const saved = await getAISettings();
  const requestedProvider = overrides?.provider ?? saved.provider;
  let fallbackApiKey = saved.apiKey;
  if (!overrides?.apiKey?.trim() && requestedProvider !== saved.provider) {
    const allSettings = await readAllSettings();
    fallbackApiKey = allSettings[providerSettingKey(requestedProvider, 'api_key')] || '';
  }
  const settings = {
    ...saved,
    ...overrides,
    provider: requestedProvider,
    // 未获 reveal 权限时前端看见的是空串；测试应继续使用数据库中的现有密钥。
    // 切换 Provider 时只能读取目标 Provider 的已保存密钥，不能串用当前密钥。
    apiKey: overrides?.apiKey?.trim() || fallbackApiKey,
  };
  const startedAt = Date.now();
  let requestStartedAt: number | undefined;
  const latencyMs = () => Date.now() - (requestStartedAt ?? startedAt);

  try {
    if (!settings.apiKey) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写 API Key',
        errorKind: 'configuration',
      };
    }
    if (!settings.baseUrl) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写 API 地址',
        errorKind: 'configuration',
      };
    }
    if (!settings.model) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: '未填写模型名称',
        errorKind: 'configuration',
      };
    }
    if (settings.provider === 'opencode' && !isOpenCodeFreeModel(settings.model)) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: 'OpenCode 仅支持免费模型',
        errorKind: 'configuration',
      };
    }

    const localCooldownMs = options.failFastOnRateLimit
      ? getAIRateLimitCooldownRemainingMs(settings.provider, settings.model)
      : 0;
    if (localCooldownMs > 0) {
      throw new AIClientError(`${settings.provider}: 请求频率超限，请稍后重试`, 'rate_limit', true, true, 429, localCooldownMs);
    }

    const result = await createOpenAICompatibleCompletion(settings, [
      { role: 'user', content: options.prompt || '请回复"连接成功"' },
    ], {
      temperature: 0.7,
      maxTokens: options.maxTokens ?? 100,
      timeoutMs: options.timeoutMs ?? AI_CONNECTION_TEST_TIMEOUT_MS,
      onRequestStart: () => {
        requestStartedAt = Date.now();
      },
      // 诊断请求不能因为某个候选模型的 5xx 污染正式文章队列的持久化冷却。
      persistProviderFailures: false,
    }, 0);

    return {
      success: true,
      provider: result.provider,
      model: result.model,
      latencyMs: latencyMs(),
      responsePreview: result.content.substring(0, 100),
    };
  } catch (error) {
    let errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (/429/.test(errorMsg) || /too many requests/i.test(errorMsg)) {
      errorMsg = '请求频率超限，请稍后重试';
    } else if (/timeout|超时/i.test(errorMsg) || /ETIMEDOUT/i.test(errorMsg)) {
      errorMsg = '请求超时，请检查网络连接';
    }
    return {
      success: false,
      provider: settings.provider,
      model: settings.model,
      error: errorMsg,
      errorKind: error instanceof AIClientError ? error.kind : 'provider',
      status: error instanceof AIClientError ? error.status : undefined,
      retryAfterMs: error instanceof AIClientError ? error.retryAfterMs : undefined,
      latencyMs: latencyMs(),
    };
  }
}

/**
 * 使用服务端已保存的配置测试指定免费模型，不把 API Key 暴露给浏览器。
 * 模型健康面板只调用此入口，避免复用设置编辑器里的脱敏/临时输入值。
 */
export async function testSavedAIModel(
  provider: AIProviderId,
  model: string,
  options?: AIConnectionTestOptions,
): Promise<AIConnectionTestResult> {
  const normalizedModel = model.trim();
  if (!isFreeAIModel(provider, normalizedModel)) {
    return {
      success: false,
      provider,
      model: normalizedModel,
      error: '仅允许测试免费模型',
      errorKind: 'configuration',
    };
  }

  const allSettings = await readAllSettings();
  const providerDefinition = AI_PROVIDERS[provider];
  const apiKey = allSettings[providerSettingKey(provider, 'api_key')]?.trim() || '';
  if (!apiKey) {
    return {
      success: false,
      provider,
      model: normalizedModel,
      error: '未填写 API Key',
      errorKind: 'configuration',
    };
  }

  const healthTestOptions: AIConnectionTestOptions = {
    prompt: '只回复 OK，不要解释。',
    maxTokens: AI_HEALTH_TEST_MAX_TOKENS,
    timeoutMs: AI_HEALTH_TEST_TIMEOUT_MS,
    failFastOnRateLimit: true,
    ...options,
  };

  return testAIConnection({
    provider,
    apiKey,
    baseUrl: allSettings[providerSettingKey(provider, 'base_url')]?.trim() || providerDefinition.baseUrl,
    model: normalizedModel,
  }, healthTestOptions);
}
