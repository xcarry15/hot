// ========== Types ==========

import type { ArticleProgress } from '@/contracts/crawl-log'

export function isArticleSkipped(a: ArticleProgress): boolean {
  return [a.crawl, a.process, a.ai, a.cluster, a.push].some(s =>
    s === 'skipped' || s === 'filtered' || s === 'not_applicable'
  )
}

export function isArticleFullyDone(a: ArticleProgress): boolean {
  return a.crawl === 'done' && a.process === 'done' && a.ai === 'done' && a.cluster === 'done' && a.push === 'done'
}

export function isArticleFailed(a: ArticleProgress): boolean {
  return [a.crawl, a.process, a.ai, a.cluster, a.push].some(s => s === 'failed')
}

// ========== Filter predicates ==========
// 状态筛选为单选；null/空集合表示“全部”。

export type StepFilterKey =
  | 'normal-all'
  | 'normal-processing'
  | 'normal-ai'
  | 'normal-cluster'
  | 'normal-push'
  | 'normal-pushed'
  | 'anomaly-all'
  | 'anomaly-manual'
  | 'anomaly-review'
  | 'anomaly-ad'
  | 'anomaly-duplicate'
  | 'anomaly-failure'
  | 'anomaly-low-confidence'
  | 'ignored'

export const ALL_STEP_FILTER_KEYS: readonly StepFilterKey[] = [
  'normal-all', 'normal-processing', 'normal-ai', 'normal-cluster', 'normal-push', 'normal-pushed',
  'anomaly-all', 'anomaly-manual', 'anomaly-review', 'anomaly-ad', 'anomaly-duplicate', 'anomaly-failure',
  'anomaly-low-confidence',
  'ignored',
] as const

export interface FilterState {
  /** 单选状态；使用 Set 保持现有 URL/调用契约，但最多只保留一个值 */
  chips: ReadonlySet<StepFilterKey>
  /** 数据源范围；'all' = 不按源过滤 */
  sourceId: string
  /** 是否把该 source 的 discarded 项也纳入可见集合（管理员调试去重/过滤原因用） */
  includeDiscarded: boolean
  /** 是否只看今天发布的文章（基于文章自身的 publishedAt） */
  publishedToday: boolean
}

export const EMPTY_FILTER_STATE: FilterState = {
  chips: new Set<StepFilterKey>(),
  sourceId: 'all',
  // 默认显示未入库（保留旧 UI 行为：discarded 段默认可见）
  includeDiscarded: true,
  publishedToday: false,
}

/**
 * 判断用户是否主动施加了筛选条件。
 * includeDiscarded=false（主动关闭"含未入库"）也视为筛选已生效，
 * 避免管理员隐藏未入库后看到"等待抓取任务"空态误导。
 */
export function isFilterStateActive(s: FilterState): boolean {
  return s.chips.size > 0 || s.sourceId !== 'all' || s.publishedToday || !s.includeDiscarded
}

export type { ArticleProgress, DiscardedRow, SourceProgress, StepStatus } from '@/contracts/crawl-log'

export interface SessionStats {
  totalSources: number
  currentSource: number
  sourceName: string
  newArticles: number
  aiProcessed: number
  pushed: number
  errors: number
  isRunning: boolean
  stageLabel?: string
}

export type StageKey = 'collect' | 'process' | 'ai' | 'cluster' | 'push' | 'all'

export type StageLoading = Record<StageKey, boolean>

export const EMPTY_STAGE_LOADING: StageLoading = {
  collect: false,
  process: false,
  ai: false,
  cluster: false,
  push: false,
  all: false,
}
