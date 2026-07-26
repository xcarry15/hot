// ========== Pure filter logic ==========
// 从 React 组件里抽出来，便于 vitest 直接测覆盖，无需 mount 组件。

import type {
  ArticleProgress, FilterState, SourceProgress, StepFilterKey,
} from './types'
import {
  ALL_STEP_FILTER_KEYS, EMPTY_FILTER_STATE, isArticleFailed,
} from './types'
import { URL_PARAM_CHIPS, URL_PARAM_SRC, URL_PARAM_DISC, URL_PARAM_TODAY } from './constants'
import { isTechnicalSkipReason } from '@/lib/article-pipeline-status'

export type ArticleFilterBucket =
  | 'normal-processing'
  | 'normal-ai'
  | 'normal-no-event'
  | 'normal-multi-event'
  | 'normal-cluster'
  | 'normal-push'
  | 'normal-pushed'
  | 'anomaly-manual'
  | 'anomaly-review'
  | 'anomaly-business'
  | 'anomaly-failure'
  | 'ignored'

export function getArticleFilterBucket(article: ArticleProgress): ArticleFilterBucket {
  if (article.technicalState === 'ignored') return 'ignored'
  if (article.technicalState === 'manual') return 'anomaly-manual'
  if (article.clusterStatus === 'needs_review') return 'anomaly-review'
  if (
    article.technicalState === 'auto_retry'
    || (article.technicalIssues?.length ?? 0) > 0
    || isArticleFailed(article)
    || Boolean(isTechnicalSkipReason(article.skipReason) && (article.crawl === 'skipped' || article.ai === 'skipped'))
  ) return 'anomaly-failure'
  if ((article.anomalyLabels?.length ?? 0) > 0) return 'anomaly-business'
  if (article.skipReason === '无具体事件') return 'normal-no-event'
  if (article.skipReason === '多事件聚合稿') return 'normal-multi-event'
  if (article.push === 'done') return 'normal-pushed'
  if (article.ai === 'done' && article.cluster === 'pending') return 'normal-cluster'
  if (article.cluster === 'done' && article.push === 'pending') return 'normal-push'
  if (article.process === 'done' && article.ai === 'pending') return 'normal-ai'
  return 'normal-processing'
}

export function hasArticleAnomaly(article: ArticleProgress): boolean {
  return getArticleFilterBucket(article).startsWith('anomaly-')
}

/**
 * 单个 chip 对一篇文章的命中判断。
 *
 * 这是 filter 的最小判定单元，每个 key 都应是"互不蕴含"的可观察谓词。
 * 例如一篇文章可同时命中软文和重复，但一级状态仍保持互斥。
 */
export function matchStepChip(article: ArticleProgress, key: StepFilterKey): boolean {
  const bucket = getArticleFilterBucket(article)
  switch (key) {
    case 'normal-all':
      return bucket.startsWith('normal-')
    case 'anomaly-all':
      return bucket.startsWith('anomaly-')
    case 'anomaly-ad':
      return article.anomalyLabels?.includes('ad') ?? false
    case 'anomaly-duplicate':
      return article.anomalyLabels?.includes('duplicate') ?? false
    case 'anomaly-low-confidence':
      return article.anomalyLabels?.includes('low-confidence') ?? false
    case 'normal-no-event':
      return article.skipReason === '无具体事件'
    case 'normal-multi-event':
      return article.skipReason === '多事件聚合稿'
    case 'normal-public':
      return article.isPublic
    case 'ignored':
      return bucket === 'ignored'
    default:
      return bucket === key
  }
}

/**
 * 把 FilterState 应用到 sources，返回过滤后的 sources。
 *
 * 规则：
 * - sourceId !== 'all' → 只保留该 source
 * - 选中状态 → 文章只按该状态过滤
 * - publishedToday = true → 只保留 publishedAt 为今天的文章
 * - includeDiscarded = false → 清空 discarded 字段（隐藏"未入库"段，不渲染）
 * - 末尾过滤掉无 articles 且无 discarded 的 source
 */
export function applyFilterState(
  sources: readonly SourceProgress[],
  state: FilterState,
): SourceProgress[] {
  const selectedChip = state.chips.values().next().value as StepFilterKey | undefined
  const today = new Date().toDateString()
  return sources
    .filter(s => state.sourceId === 'all' || s.id === state.sourceId)
    .map(s => {
      // 已忽略项默认隐藏，只在用户主动选择“已忽略”筛选时展示，避免长期挂在任务列表。
      let articles = !selectedChip
        ? s.articles.filter(a => a.technicalState !== 'ignored')
        : s.articles.filter(a => matchStepChip(a, selectedChip))
      if (state.publishedToday) {
        articles = articles.filter(a => {
          if (!a.publishedAt) return false
          return new Date(a.publishedAt).toDateString() === today
        })
      }
      // P0-5: 状态筛选激活时，未入库条目也受约束。
      // chip 激活 → 隐藏未入库区（状态 chip 只对已入库文章有意义）
      // publishedToday → 也按日期过滤未入库条目
      let discarded = s.discarded
      if (selectedChip) {
        // 选择了具体状态 → 隐藏未入库（状态 chip 不适用于未入库条目）
        discarded = []
      } else if (state.includeDiscarded) {
        if (state.publishedToday) {
          discarded = discarded.filter(d => {
            const dateStr = d.publishedAt || d.createdAt
            if (!dateStr) return false
            return new Date(dateStr).toDateString() === today
          })
        }
      } else {
        discarded = []
      }
      return { ...s, articles, discarded }
    })
    .filter(s => {
      if (s.articles.length > 0 || s.discarded.length > 0) return true
      // 0 结果的 source（SSE 添加、DB 无 article）只在无 chip/today 筛选 + includeDiscarded=true 时保留。
      // includeDiscarded=false 时无法区分"原本有 discarded 被隐藏"和"真正 0 结果"，保守不保留。
      if (!selectedChip && !state.publishedToday && state.includeDiscarded && s.itemsFound === 0) {
        return true
      }
      // P0-3: 有运行结果的源（即使 0 条文章/未入库）也保留，让管理员看到失败/0 条源
      if (!selectedChip && s.lastRunStatus != null && s.lastRunStatus !== 'not-run') {
        return true
      }
      return false
    })
}

/**
 * 把 FilterState 编码为 URLSearchParams。
 *
 * 设计原则：与 EMPTY_FILTER_STATE 等价的字段不写入 URL。
 * - chips=空 → 不写
 * - sourceId='all' → 不写
 * - includeDiscarded===EMPTY 默认值 → 不写（清空筛选 = URL 完全干净）
 *
 * 这样保证 "点清除筛选" 后 URL 真的变干净，而不是残留 `?disc=1` 之类。
 */
export function encodeFilterToSearch(state: FilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.chips.size > 0) {
    // 防御：忽略未知 key，免得污染 URL
    const valid = new Set<string>(ALL_STEP_FILTER_KEYS as readonly string[])
    const selected = Array.from(state.chips).find(k => valid.has(k))
    if (selected) params.set(URL_PARAM_CHIPS, selected)
  }
  if (state.sourceId !== EMPTY_FILTER_STATE.sourceId) params.set(URL_PARAM_SRC, state.sourceId)
  if (state.includeDiscarded !== EMPTY_FILTER_STATE.includeDiscarded) {
    params.set(URL_PARAM_DISC, state.includeDiscarded ? '1' : '0')
  }
  if (state.publishedToday) params.set(URL_PARAM_TODAY, '1')
  return params
}

/**
 * 从 search string 解码 FilterState。
 *
 * 防御性：未知 chip key 直接丢弃（不是抛错），确保分享过期链接也不会崩。
 * 同理 src 必须非空字符串。
 *
 * 注意：empty search 默认返回值与 EMPTY_FILTER_STATE 必须保持一致，
 * 包含 includeDiscarded=true。否则会造成 "URL 上写 disc=1 才显示未入库"
 * 的反直觉行为。
 */
export function decodeFilterFromSearch(search: string): FilterState {
  const params = new URLSearchParams(search)
  const valid = new Set<string>(ALL_STEP_FILTER_KEYS as readonly string[])
  const chips = new Set<StepFilterKey>()
  const raw = params.get(URL_PARAM_CHIPS)
  if (raw) {
    for (const k of raw.split(',')) {
      const trimmed = k.trim()
      if (valid.has(trimmed)) {
        chips.add(trimmed as StepFilterKey)
        break
      }
    }
  }
  const sourceIdRaw = params.get(URL_PARAM_SRC)
  const sourceId = sourceIdRaw && sourceIdRaw.length > 0 ? sourceIdRaw : 'all'
  // includeDiscarded 三态：无参数 → 默认 true（与 EMPTY_FILTER_STATE 对齐）
  //                  disc=1   → true
  //                  其他值   → false（用户显式关闭）
  const discParam = params.get(URL_PARAM_DISC)
  const includeDiscarded = discParam === null ? true : discParam === '1'
  // publishedToday：today=1 → true，其他值/无参数 → false
  const todayParam = params.get(URL_PARAM_TODAY)
  const publishedToday = todayParam === '1'
  return { chips, sourceId, includeDiscarded, publishedToday }
}

/**
 * 用 search params 重写 URL，避免污染浏览器历史栈。
 * replaceState 本身在 URL 无变化时是 no-op，无需额外比较。
 *
 * 安全：只在浏览器环境调用，SSR/prerender 安全。
 */
export function writeFilterToUrl(state: FilterState): void {
  if (typeof window === 'undefined') return
  const next = encodeFilterToSearch(state)
  const url = new URL(window.location.href)
  for (const key of [URL_PARAM_CHIPS, URL_PARAM_SRC, URL_PARAM_DISC, URL_PARAM_TODAY]) {
    url.searchParams.delete(key)
  }
  next.forEach((value, key) => url.searchParams.set(key, value))
  window.history.replaceState(null, '', url.toString())
}

export function readFilterFromCurrentUrl(): FilterState {
  if (typeof window === 'undefined') return EMPTY_FILTER_STATE
  return decodeFilterFromSearch(window.location.search)
}
