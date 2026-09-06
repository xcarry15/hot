/**
 * AI 错误的持久化摘要。
 *
 * 模型响应、Provider 错误正文和任意异常文本都可能包含文章内容或提示词，
 * 因此 Article.aiError / Job 错误字段只允许保存这个稳定的分类摘要。
 */
type AIErrorShape = {
  kind?: unknown;
  status?: unknown;
};

const ERROR_LABELS = {
  configuration: 'AI 配置错误',
  rate_limit: 'AI 请求受限',
  provider: 'AI 服务暂不可用',
  network: 'AI 网络连接失败',
  timeout: 'AI 请求超时',
  content: 'AI 请求内容无法处理',
} as const;

export function summarizeAIError(error: unknown): string {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'AI 分析失败';
  const shape = error as AIErrorShape;
  if (typeof shape.kind !== 'string' || !(shape.kind in ERROR_LABELS)) return 'AI 分析失败';

  const label = ERROR_LABELS[shape.kind as keyof typeof ERROR_LABELS];
  return typeof shape.status === 'number' && Number.isInteger(shape.status)
    ? `${label}（${shape.status}）`
    : label;
}
