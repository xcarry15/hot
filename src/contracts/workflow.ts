/**
 * Article 流程状态契约。
 *
 * Prisma 目前仍以 String 保存部分状态；所有跨服务的状态判断先在这里
 * 收敛，避免各处手写字符串和退避条件。数据库基线重建时可直接把这些
 * 常量映射为 Prisma enum。
 */
export const ARTICLE_FETCH_STATUSES = ['pending', 'fetched', 'failed'] as const
export const ARTICLE_AI_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const
export const ARTICLE_CLUSTER_STATUSES = ['pending', 'clustered', 'failed', 'needs_review'] as const
export const ARTICLE_PUBLIC_OVERRIDES = ['auto', 'public', 'hidden'] as const
export const ARTICLE_PUBLIC_STATUSES = ['unpublished', 'published', 'revoked'] as const

export type ArticleFetchStatus = (typeof ARTICLE_FETCH_STATUSES)[number]
export type ArticleAiStatus = (typeof ARTICLE_AI_STATUSES)[number]
export type ArticleClusterStatus = (typeof ARTICLE_CLUSTER_STATUSES)[number]
export type ArticlePublicOverride = (typeof ARTICLE_PUBLIC_OVERRIDES)[number]
export type ArticlePublicStatus = (typeof ARTICLE_PUBLIC_STATUSES)[number]

function isIn<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T)
}

export const isArticleFetchStatus = (value: string): value is ArticleFetchStatus => isIn(ARTICLE_FETCH_STATUSES, value)
export const isArticleAiStatus = (value: string): value is ArticleAiStatus => isIn(ARTICLE_AI_STATUSES, value)
export const isArticleClusterStatus = (value: string): value is ArticleClusterStatus => isIn(ARTICLE_CLUSTER_STATUSES, value)
export const isArticlePublicOverride = (value: string): value is ArticlePublicOverride => isIn(ARTICLE_PUBLIC_OVERRIDES, value)
export const isArticlePublicStatus = (value: string): value is ArticlePublicStatus => isIn(ARTICLE_PUBLIC_STATUSES, value)

export interface ArticleWorkflowState {
  fetchStatus: string
  aiStatus: string
  clusterStatus: string
  skipReason?: string | null
  nextFetchRetryAt?: Date | null
  nextAiRetryAt?: Date | null
  nextClusterRetryAt?: Date | null
}

/** AI Provider 冷却中的 pending，不是失败，也不应进入失败统计。 */
export function isAiRetryWaiting(
  state: Pick<ArticleWorkflowState, 'aiStatus' | 'nextAiRetryAt'>,
  now = new Date(),
): boolean {
  return state.aiStatus === 'pending'
    && state.nextAiRetryAt != null
    && state.nextAiRetryAt.getTime() > now.getTime()
}

/** AI 等待窗口已到期，可由恢复调度或人工流程重新处理。 */
export function isAiRetryDue(
  state: Pick<ArticleWorkflowState, 'aiStatus' | 'nextAiRetryAt'>,
  now = new Date(),
): boolean {
  return state.aiStatus === 'pending'
    && state.nextAiRetryAt != null
    && state.nextAiRetryAt.getTime() <= now.getTime()
}

export function isTechnicalAiFailure(state: Pick<ArticleWorkflowState, 'aiStatus' | 'skipReason'>): boolean {
  return state.aiStatus === 'failed'
    || (state.aiStatus === 'skipped' && state.skipReason?.startsWith('AI 连续失败') === true)
}

/** 只表达可恢复的技术异常，不包含正常业务跳过。 */
export function isRecoverableFailure(state: ArticleWorkflowState): boolean {
  return state.fetchStatus === 'failed'
    || isTechnicalAiFailure(state)
    || state.clusterStatus === 'failed'
}
