/**
 * AI Provider 纯契约。
 *
 * 本文件只能包含客户端和服务端都能安全使用的元数据、类型和纯函数，
 * 不得导入数据库、Node API、缓存或网络客户端。
 */
export const AI_PROVIDERS = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode (免费)',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'big-pickle',
    models: ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-super-free'],
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
} as const;

export type AIProviderId = keyof typeof AI_PROVIDERS;

export function providerSettingKey(providerId: string, field: string): string {
  return `${providerId}_${field}`;
}
