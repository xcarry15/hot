import type { StepFilterKey } from './types'

export type FilterChipKey = StepFilterKey | 'all'

/**
 * 多选 chip 定义。顺序经调整便于阅读：先看"已完成"，再看"待处理"，再排查异常。
 *
 * 注意：标签尽量短（最多 4 字中文 + 括号数量），避免在窄屏挤成竖排。
 */
export interface StepFilterChip {
  key: FilterChipKey
  label: string
  /** 给 a11y / tooltip 用的一句话说明 */
  description: string
}

export const STEP_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'all', label: '全部', description: '显示全部文章' },
  { key: 'ai-done', label: '已AI', description: 'AI 分析已完成' },
  { key: 'pushed', label: '已推', description: '已推送到飞书' },
  { key: 'process-pending', label: '待处理', description: '详情抓取尚未完成' },
  { key: 'cluster-pending', label: '待聚类', description: '详情已处理，等待事件聚类' },
  { key: 'cluster-failed', label: '聚类失败', description: '事件聚类发生技术失败' },
  { key: 'cluster-review', label: '待复核', description: '聚类结果存在歧义，需要人工复核' },
  { key: 'ai-pending', label: '待AI', description: '详情已处理，等待 AI 分析' },
  { key: 'push-pending', label: '待推', description: 'AI 已完成且满足推送条件' },
  { key: 'has-fail', label: '含失败', description: '任意步骤出现失败标记' },
] as const

/** 用于 URL 深链的 chip 集合名（短名减小 URL 长度） */
export const URL_PARAM_CHIPS = 'chips'
export const URL_PARAM_SRC = 'src'
export const URL_PARAM_DISC = 'disc'
export const URL_PARAM_TODAY = 'today'
/** P2-1: 详情深链参数 */
export const URL_PARAM_DETAIL = 'detail'
export const URL_PARAM_DETAIL_KIND = 'detailKind'
export const URL_PARAM_TAB = 'tab'
