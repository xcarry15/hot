import type { StepFilterKey } from './types'

export type FilterChipKey = StepFilterKey | 'all'

/**
 * 单选状态定义。优先呈现需要动作的队列，再展示流水线阶段和完成状态。
 *
 * 注意：标签尽量短（最多 4 字中文 + 括号数量），避免在窄屏挤成竖排。
 */
export interface StepFilterChip {
  key: FilterChipKey
  label: string
  /** 给 a11y / tooltip 用的一句话说明 */
  description: string
}

export const PRIMARY_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'all', label: '全部', description: '显示当前文章，数量包含已忽略' },
  { key: 'normal-all', label: '正常', description: '按预期流转，无需人工介入' },
  { key: 'anomaly-all', label: '异常', description: '需要关注、复核或恢复的文章' },
  { key: 'ignored', label: '已忽略', description: '已从技术待办中忽略的文章' },
] as const

export const NORMAL_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'normal-all', label: '全部正常', description: '全部正常流转文章' },
  { key: 'normal-processing', label: '处理中', description: '正在采集或提取正文' },
  { key: 'normal-ai', label: '待 AI', description: '正文处理完成，等待 AI 分析' },
  { key: 'normal-cluster', label: '待聚类', description: 'AI 已生成事件身份，等待事件聚类' },
  { key: 'normal-push', label: '待推送', description: '已满足推送条件，等待投递' },
  { key: 'normal-pushed', label: '已推送', description: '已成功完成投递' },
] as const

export const ANOMALY_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'anomaly-all', label: '全部异常', description: '全部需要关注的文章' },
  { key: 'anomaly-manual', label: '需处理', description: '自动重试耗尽，需要人工处理' },
  { key: 'anomaly-review', label: '待复核', description: '聚类结果存在歧义，需要人工判断' },
  { key: 'anomaly-failure', label: '流程失败', description: '流程失败、跳过或自动恢复中' },
  { key: 'anomaly-ad', label: '软文', description: 'AI 判定为广告或软文的文章' },
  { key: 'anomaly-duplicate', label: '重复', description: '同一事件中的非代表报道' },
  { key: 'anomaly-low-confidence', label: '低置信', description: 'AI 对分析结果把握不足，建议人工复核' },
] as const

export const STEP_FILTER_CHIPS: readonly StepFilterChip[] = [
  ...PRIMARY_FILTER_CHIPS,
  ...NORMAL_FILTER_CHIPS.slice(1),
  ...ANOMALY_FILTER_CHIPS.slice(1),
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
