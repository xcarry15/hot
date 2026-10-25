/**
 * AI Provider 纯契约。
 *
 * 本文件只能包含客户端和服务端都能安全使用的元数据、类型和纯函数，
 * 不得导入数据库、Node API、缓存或网络客户端。
 */

export function isOpenRouterFreeModel(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel === 'openrouter/free' || normalizedModel.endsWith(':free');
}

export const AI_PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    // DeepSeek 官方稳定别名会指向最新 Flash 版本；此列表作为模型目录不可用时的兜底。
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    needsApiKey: true,
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    // 官方目录不可用时的文本模型兜底；是否免费取决于 Google 项目的计费层级。
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    needsApiKey: true,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter (免费模型)',
    baseUrl: 'https://openrouter.ai/api/v1',
    // 这些是 Models API 暂不可用时的兜底项；进入设置页时会同步官方最新列表。
    defaultModel: 'openrouter/free',
    models: [
      'openrouter/free',
      'qwen/qwen3.8-27b:free',
      'inclusionai/ling-3.1-flash:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'poolside/laguna-s-2.1:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'cohere/north-mini-code:free',
      'poolside/laguna-xs-2.1:free',
      'minimax/minimax-m3:free',
      'dots-studio/dots-3-note-preview:free',
      'thinkingmachines/inkling:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'thinkingmachines/inkling-small:free',
      'z-ai/glm-5.2:free',
      'minimax/minimax-m2.7:free',
      'liquid/lfm-2.5-2.6b:free',
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3.5-content-safety:free',
    ],
    needsApiKey: true,
  },
} as const;

export type AIProviderId = keyof typeof AI_PROVIDERS;

export const DEFAULT_AI_PROVIDER_ID: AIProviderId = 'openrouter';

export function isAIProviderId(value: string): value is AIProviderId {
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, value);
}

export const FREE_AI_PROVIDER_IDS = ['openrouter'] as const;
export type FreeAIProviderId = (typeof FREE_AI_PROVIDER_IDS)[number];

/** Provider 的模型收费策略唯一事实源。 */
export function isFreeAIModel(provider: string, model: string): boolean {
  if (provider === 'openrouter') return isOpenRouterFreeModel(model);
  return false;
}

export function isAIModelAllowed(provider: string, model: string): boolean {
  if (!isAIProviderId(provider)) return false;
  return provider === 'deepseek' || provider === 'gemini' || isFreeAIModel(provider, model);
}

/** Gemini 的账户层级无法从模型 ID 判断；统一保守限速，不把付费 Key 宣称为免费。 */
export function requiresConservativeAIRequests(provider: string, model: string): boolean {
  return provider === 'gemini' || isFreeAIModel(provider, model);
}

export function getAIModelValidationError(provider: string, model: string): string | null {
  if (isAIModelAllowed(provider, model)) return null;
  const definition = isAIProviderId(provider) ? AI_PROVIDERS[provider] : undefined;
  return definition ? `${definition.name} 仅允许免费模型` : '不支持的 AI Provider';
}

export function providerSettingKey(providerId: string, field: string): string {
  return `${providerId}_${field}`;
}
