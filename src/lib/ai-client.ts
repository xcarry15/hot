/**
 * Unified AI Client — OpenAI-compatible Chat Completions.
 *
 * Supported providers (OpenAI-compatible):
 *   openrouter (default, free routing) | deepseek | gemini
 *
 * The ZAI SDK is NOT used for chat. It is imported separately by `parser-html.ts`
 * and `crawler.ts` for `page_reader` / `web_search` (see `./zai`).
 *
 * Settings stored in DB (Setting table):
 *   ai_provider  — deepseek | openrouter | gemini
 *   {provider}_api_key / {provider}_base_url / {provider}_model
 *   ai_temperature — Temperature (0-2; default from settings catalog)
 *   ai_max_tokens  — Max tokens (1-65536; default from settings catalog)
 */

import { readSettings } from './settings';
import { AIClientError, type AIErrorKind } from './ai-errors';
import {
  getAIProviderSettingKeys,
  getAISettings,
} from './ai-settings';
import type { AISettings } from './ai-settings';
import { abortableDelay, withTimeout } from './shared/async';
import { fetchSafe, readResponseText } from './http';
import { getAIRateLimitCooldownRemainingMs, noteAIRateLimit, waitForAIRequestSlot, isFreeAIModel } from './ai-rate-gate';
import { clearAIProviderBackoff, getAIProviderBackoff, noteAIProviderFailure } from './ai-provider-backoff';
import { recordAIInvocation } from './ai-invocation-service';
import { getCurrentJobId } from './job-context';
import { getGeminiConfigurationError, getGeminiRetryAfterMs } from './gemini-provider';
import {
  AI_PROVIDERS,
  getAIModelValidationError,
  providerSettingKey,
  requiresConservativeAIRequests,
} from '@/contracts/ai-provider';
import type { AIProviderId } from '@/contracts/ai-provider';

export { AI_PROVIDERS, providerSettingKey } from '@/contracts/ai-provider';
export type { AIProviderId } from '@/contracts/ai-provider';

export { AIClientError } from './ai-errors';
export type { AIErrorKind } from './ai-errors';

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
  requestStarted?: boolean;
}

export interface AIConnectionTestOptions {
  prompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  failFastOnRateLimit?: boolean;
  ignoreModelFailureCooldown?: boolean;
  signal?: AbortSignal;
}

export interface AIInvocationContext {
  articleId: string;
}

function isArticleRequestError(status: number, message: string): boolean {
  if (status === 413 || status === 422) return true;
  if (status !== 400) return false;
  return /context length|maximum context|too many tokens|prompt.{0,20}(long|large)|messages?.{0,20}(long|large)|request.{0,20}too large/i.test(message);
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

const AI_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const AI_HEALTH_TEST_TIMEOUT_MS = 12_000;
export const AI_MODEL_TIMEOUT_MS = 5 * 60_000;
const AI_HEALTH_TEST_MAX_TOKENS = 16;
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

// ── Unified Chat Completion ───────────────────────────────────────

/**
 * Create a chat completion using the configured provider.
 * Supported providers use OpenAI-compatible APIs.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; invocation?: AIInvocationContext }
): Promise<ChatCompletionResponse> {
  const settings = await getAISettings();

  const finalOptions = {
    temperature: options?.temperature ?? settings.temperature,
    maxTokens: options?.maxTokens ?? settings.maxTokens,
  };

  return createOpenAICompatibleCompletion(settings, messages, {
    ...finalOptions,
    invocation: options?.invocation,
  }, 2, options?.signal);
}

/**
 * OpenAI-compatible Chat Completions。
 */
async function createOpenAICompatibleCompletion(
  settings: AISettings,
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number; timeoutMs?: number; onRequestStart?: () => void; persistProviderFailures?: boolean; ignoreModelFailureCooldown?: boolean; invocation?: AIInvocationContext },
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
  const modelValidationError = getAIModelValidationError(settings.provider, settings.model);
  if (modelValidationError) {
    throw new AIClientError(modelValidationError, 'configuration', true, false);
  }
  const url = `${baseUrl}/chat/completions`;
  // Gemini 和免费模型的失败请求也可能消耗额度；不要在 429 后立即重复发送。
  const effectiveRetries = requiresConservativeAIRequests(settings.provider, settings.model) ? 0 : retries;

  const persistedBackoff = await getAIProviderBackoff(settings.provider);
  const persistedCooldownMs = persistedBackoff?.cooldownUntil
    ? Math.max(0, persistedBackoff.cooldownUntil.getTime() - Date.now())
    : 0;
  // 候选模型探测可以绕过模型错误引发的退避，但必须保留限流、网络等共享冷却。
  const modelFailureCooldown = options.ignoreModelFailureCooldown
    && persistedBackoff?.lastErrorKind === 'provider'
    && persistedBackoff?.lastStatus !== 429;
  if (persistedCooldownMs > 0 && !modelFailureCooldown) {
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

  const body: Record<string, unknown> = {
    model: settings.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    // 结构化输出由 Prompt + 客户端 Schema 校验保证，避免不兼容参数触发重试。
  };

  if (settings.provider === 'gemini') {
    // Gemini 3.8 已移除采样参数，且不支持 minimal；low 同时兼容当前 Flash 系列。
    delete body.temperature;
    delete body.max_tokens;
    body.max_completion_tokens = options.maxTokens;
    body.reasoning_effort = 'low';
  }

  // 正文分析 prompt 较长，所有模型统一允许最多 5 分钟。
  // 单篇超时由 AI pipeline 记录为当前文章失败，不能因为一篇慢文章暂停整批。
  const timeoutMs = options.timeoutMs ?? AI_MODEL_TIMEOUT_MS;

  console.log(`[ai-client] Calling ${settings.provider}: POST ${url} model=${settings.model}`);

  let lastError: { status: number; kind: AIErrorKind; retryAfterMs?: number } | null = null;
  let invocationStartedAt: number | undefined;

  const reportInvocation = (outcome: 'success' | 'error', errorKind = '', statusCode?: number) => {
    if (!options.invocation || invocationStartedAt === undefined) return;
    const durationMs = Date.now() - invocationStartedAt;
    invocationStartedAt = undefined;
    void recordAIInvocation({
      articleId: options.invocation.articleId,
      jobId: getCurrentJobId(),
      provider: settings.provider,
      model: settings.model,
      outcome,
      errorKind,
      statusCode,
      durationMs,
    }).catch((error: unknown) => {
      console.error('[ai-client] 记录 AI 调用统计失败:', error);
    });
  };

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
        invocationStartedAt = Date.now();
        const rawResponse = await fetchSafe(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
            ...(settings.provider === 'gemini' ? { 'x-goog-api-client': 'site-selection-assistant-oai/1.0' } : {}),
          },
          body: JSON.stringify(body),
          signal,
        });
        const bodyText = await readResponseText(rawResponse);
        return { ok: rawResponse.ok, status: rawResponse.status, bodyText, headers: rawResponse.headers };
      }, timeoutMs, `${settings.provider} request timeout`, parentSignal);
    } catch (fetchError) {
      if (parentSignal?.aborted) {
        reportInvocation('error', 'timeout');
        throw fetchError;
      }
      const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      const errorKind = /timeout|aborted|aborterror/i.test(errMsg) ? 'timeout' : 'network';
      reportInvocation('error', errorKind);

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
      throw new AIClientError(`${settings.provider}: 请求失败`, 'network', false, true);
    }
    if (response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(response.bodyText || '{}') as unknown;
      } catch {
        reportInvocation('error', 'provider', response.status);
        throw await buildProviderPayloadError(
          settings,
          response.status,
          `${settings.provider}: API 返回无效 JSON`,
          options.persistProviderFailures !== false,
        );
      }
      const rawContent = data && typeof data === 'object' && !Array.isArray(data)
          ? (((data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content))
          : undefined;
      const content = typeof rawContent === 'string' ? rawContent : '';

      if (!content) {
        const finishReason = settings.provider === 'gemini' && data && typeof data === 'object'
          ? (data as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason
          : undefined;
        if (finishReason === 'length' || finishReason === 'content_filter') {
          reportInvocation('error', 'content', response.status);
          throw new AIClientError(
            finishReason === 'length' ? 'Gemini 输出 token 上限不足，请提高最大 tokens 后重试' : '当前内容被 Gemini 安全策略拦截',
            'content', false, false, response.status,
          );
        }
        reportInvocation('error', 'provider', response.status);
        throw await buildProviderPayloadError(
          settings,
          response.status,
          `${settings.provider}: API 返回空响应`,
          options.persistProviderFailures !== false,
        );
      }

      // 这里的 success 是“上游返回了非空响应”的传输层结果；结构化 JSON
      // 校验属于 ai.ts 的分析层，不能把两种语义混进同一个请求统计字段。
      reportInvocation('success', '', response.status);

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
    const geminiConfigurationError = settings.provider === 'gemini' ? getGeminiConfigurationError(errorText) : null;
    const errorKind: AIErrorKind = response.status === 429
      ? 'rate_limit'
      : geminiConfigurationError || response.status === 401 || response.status === 402 || response.status === 403
        ? 'configuration'
        : response.status >= 500
          ? 'provider'
          : isArticleRequestError(response.status, errorText)
            ? 'content'
            : 'provider';
    reportInvocation('error', errorKind, response.status);
    console.error(`[ai-client] ${settings.provider} API error (${response.status}), kind=${errorKind}`);

    const retryAfterMs = response.status === 429
      ? parseRetryAfterMs(response.headers) ?? (settings.provider === 'gemini' ? getGeminiRetryAfterMs(errorText) : undefined)
      : undefined;
    if (response.status === 429) {
      noteAIRateLimit(settings.provider, settings.model, retryAfterMs);
    }
    lastError = { status: response.status, kind: errorKind, retryAfterMs };

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

    if (geminiConfigurationError) {
      throw new AIClientError(geminiConfigurationError, 'configuration', true, false, response.status);
    }

    if (response.status === 401) {
      throw new AIClientError(`${settings.provider}: API Key 无效或鉴权失败`, 'configuration', true, false, response.status);
    }

    if (response.status === 403) {
      // 只识别已知限制并返回固定文案，禁止把上游正文或凭据带入页面、日志和文章状态。
      const accessError = /not available in your country|unsupported_country|country.{0,30}not supported|region.{0,30}not supported/i.test(errorText)
        ? '当前模型不向所在地区提供服务，请选择其他模型或厂商'
        : '访问被拒绝，请检查模型权限、地区或服务商使用限制';
      throw new AIClientError(`${settings.provider}: ${accessError}`, 'configuration', true, false, response.status);
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
    if (lastError.kind === 'content') {
      throw new AIClientError(
        `${settings.provider} API 错误 (${lastError.status})`,
        'content',
        false,
        false,
        lastError.status,
      );
    }
    throw new AIClientError(
      `${settings.provider} API 错误 (${lastError.status})`,
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
  let saved: AISettings;
  try {
    saved = await getAISettings(overrides?.provider);
  } catch (error) {
    if (!(error instanceof AIClientError)) throw error;
    return {
      success: false, provider: overrides?.provider ?? '', model: overrides?.model ?? '',
      error: error.message, errorKind: error.kind,
    };
  }
  const settings = {
    ...saved,
    ...overrides,
    // 切换厂商时只读取目标厂商配置；空串是未 reveal 的脱敏占位。
    apiKey: overrides?.apiKey?.trim() || saved.apiKey,
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
    const modelValidationError = getAIModelValidationError(settings.provider, settings.model);
    if (modelValidationError) {
      return {
        success: false,
        provider: settings.provider,
        model: settings.model,
        error: modelValidationError,
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
      // 思考模型需要给推理和可见回复留出预算，不能沿用 16/100 tokens 的普通探测。
      maxTokens: options.maxTokens ?? (settings.provider === 'gemini' ? 2048 : 100),
      timeoutMs: options.timeoutMs ?? (settings.provider === 'gemini' ? 30_000 : AI_CONNECTION_TEST_TIMEOUT_MS),
      onRequestStart: () => {
        requestStartedAt = Date.now();
      },
      // 诊断请求不能因为某个候选模型的 5xx 污染正式文章队列的持久化冷却。
      persistProviderFailures: false,
      ignoreModelFailureCooldown: options.ignoreModelFailureCooldown,
    }, 0, options.signal);

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
      requestStarted: requestStartedAt !== undefined,
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

  const allSettings = await readSettings(getAIProviderSettingKeys(provider));
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
    ignoreModelFailureCooldown: true,
    ...options,
  };

  return testAIConnection({
    provider,
    apiKey,
    baseUrl: allSettings[providerSettingKey(provider, 'base_url')]?.trim() || providerDefinition.baseUrl,
    model: normalizedModel,
  }, healthTestOptions);
}
