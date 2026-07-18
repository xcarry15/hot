// ========== Types ==========

import type { ArticleProgress } from '@/contracts/crawl-log'

export function isArticleSkipped(a: ArticleProgress): boolean {
  return [a.crawl, a.process, a.cluster, a.ai, a.push].some(s =>
    s === 'skipped' || s === 'filtered' || s === 'not_applicable'
  )
}

export function isArticleFullyDone(a: ArticleProgress): boolean {
  return a.crawl === 'done' && a.process === 'done' && a.cluster === 'done' && a.ai === 'done' && a.push === 'done'
}

export function isArticleFailed(a: ArticleProgress): boolean {
  return [a.crawl, a.process, a.cluster, a.ai, a.push].some(s => s === 'failed')
}

// ========== Filter predicates ==========
// 多选 chip：同一时间可选多个，匹配逻辑为 OR（任一命中即保留）。
// 选 0 个 = 不按状态过滤，显示所有文章。

export type StepFilterKey =
  | 'ai-done'        // AI 分析完成
  | 'pushed'         // 已推送（push === 'done'）
  | 'process-pending' // 待详情抓取
  | 'cluster-pending' // 待事件聚类
  | 'cluster-failed' // 聚类技术失败
  | 'cluster-review' // 聚类结果待人工复核
  | 'ai-pending'     // 待 AI 分析
  | 'push-pending'   // 待推送
  | 'has-fail'       // 任意步骤失败

export const ALL_STEP_FILTER_KEYS: readonly StepFilterKey[] = [
  'ai-done', 'pushed',
  'process-pending', 'cluster-pending', 'cluster-failed', 'cluster-review', 'ai-pending', 'push-pending',
  'has-fail',
] as const

/**
 * P2-2: 旧 'in-progress' URL 参数的迁移别名。
 * 页面已不再显示此 chip，但旧链接中可能存在。自动转换为空筛选（显示全部）。
 */
export const DEPRECATED_STEP_FILTER_KEYS = new Set(['in-progress'])

export interface FilterState {
  /** 多选 chip：OR 联合；为空 = 不按状态过滤 */
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

export type StageKey = 'collect' | 'process' | 'cluster' | 'ai' | 'push' | 'all'

export type StageLoading = Record<StageKey, boolean>

export const EMPTY_STAGE_LOADING: StageLoading = {
  collect: false,
  process: false,
  cluster: false,
  ai: false,
  push: false,
  all: false,
}
