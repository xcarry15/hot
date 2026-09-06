/**
 * Article 流程状态契约。
 *
 * Prisma 目前仍以 String 保存部分状态；所有跨服务的状态判断先在这里
 * 收敛，避免各处手写字符串和退避条件。数据库基线重建时可直接把这些
 * 常量映射为 Prisma enum。
 */
import {
  AI_STATUS_VALUES,
  CLUSTER_STATUS_VALUES,
  FETCH_STATUS_VALUES,
  PUBLIC_OVERRIDE_VALUES,
  PUBLIC_STATUS_VALUES,
} from '@/contracts/state'
import type {
  AIStatus,
  ClusterStatus,
  FetchStatusValue,
  PublicOverride,
  PublicStatus,
} from '@/contracts/state'

export const ARTICLE_FETCH_STATUSES = FETCH_STATUS_VALUES
export const ARTICLE_AI_STATUSES = AI_STATUS_VALUES
export const ARTICLE_CLUSTER_STATUSES = CLUSTER_STATUS_VALUES
export const ARTICLE_PUBLIC_OVERRIDES = PUBLIC_OVERRIDE_VALUES
export const ARTICLE_PUBLIC_STATUSES = PUBLIC_STATUS_VALUES

export type ArticleFetchStatus = FetchStatusValue
export type ArticleAiStatus = AIStatus
export type ArticleClusterStatus = ClusterStatus
export type ArticlePublicOverride = PublicOverride
export type ArticlePublicStatus = PublicStatus

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
