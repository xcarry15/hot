/**
 * AI Provider 纯契约。
 *
 * 本文件只能包含客户端和服务端都能安全使用的元数据、类型和纯函数，
 * 不得导入数据库、Node API、缓存或网络客户端。
 */

/**
 * OpenCode 当前 Zen 免费模型采用的协议。
 *
 * OpenCode 的 Models API 目前主要返回模型 ID，不返回统一的协议元数据，
 * 因此保留官方文档中唯一 Responses 免费模型的显式映射，其余免费模型走
 * OpenAI Chat Completions 兼容端点。
 */
export type OpenCodeModelProtocol = 'chat' | 'responses';

export const OPENCODE_RESPONSES_MODEL_IDS = [
  'muse-spark-1.2-contributor-free',
] as const;

export function isOpenCodeFreeModel(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel === 'big-pickle' || normalizedModel.endsWith('-free');
}

export function isOpenRouterFreeModel(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel === 'openrouter/free' || normalizedModel.endsWith(':free');
}

export function getOpenCodeModelProtocol(model: string): OpenCodeModelProtocol {
  const normalizedModel = model.trim().toLowerCase();
  return OPENCODE_RESPONSES_MODEL_IDS.some((id) => id === normalizedModel)
    ? 'responses'
    : 'chat';
}

export const AI_PROVIDERS = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode (免费)',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'big-pickle',
    // OpenCode 推荐模型由 /api/settings/opencode-models 动态刷新；这里仅作为接口不可用时的兜底。
    models: [
      'big-pickle',
      'deepseek-v4-flash-free',
      'mimo-v2.5-free',
      'hy3-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'muse-spark-1.2-contributor-free',
      'laguna-s-2.1-free',
    ],
    needsApiKey: true,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
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

export function providerSettingKey(providerId: string, field: string): string {
  return `${providerId}_${field}`;
}
