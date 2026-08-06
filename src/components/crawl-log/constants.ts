import type { StepFilterKey } from './types'

export type FilterChipKey = StepFilterKey | 'all'

/**
 * 单选状态定义。优先呈现需要动作的队列，再展示流水线阶段和完成状态。
 *
 * 注意：标签尽量短（最多 5 字中文 + 括号数量），避免在窄屏挤成竖排。
 */
export interface StepFilterChip {
  key: FilterChipKey
  label: string
  /** 给 a11y / tooltip 用的一句话说明 */
  description: string
}

export const PRIMARY_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'all', label: '全部', description: '显示当前窗口文章，数量包含已忽略' },
  { key: 'processing-all', label: '处理中', description: '仍在正文、AI、聚类或推送环节等待完成' },
  { key: 'normal-all', label: '正常', description: '已经公开的 Event 代表文章；公开是正常状态的唯一事实口径' },
  { key: 'anomaly-all', label: '异常', description: '尚未公开且存在流程失败、自动恢复、未达门槛或无价值等问题' },
  { key: 'attention-all', label: '待操作', description: '人工关注快捷入口，可与正常或异常状态重叠' },
] as const

/** 处理中只保留真正有下一步流水线动作的阶段。 */
export const PROCESSING_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'normal-processing', label: '待正文', description: '等待正文抓取或正文处理' },
  { key: 'normal-ai', label: '待 AI', description: '正文已完成，等待 AI 分析' },
  { key: 'normal-cluster', label: '待聚类', description: 'AI 已完成，等待事件聚类' },
  { key: 'normal-push', label: '待推送', description: '已满足当前推送条件，等待投递' },
] as const

export const NORMAL_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'normal-public', label: '已公开', description: '已在公开端展示的 Event 代表文章' },
  { key: 'normal-pushed', label: '已推送', description: '已公开且成功完成推送的 Event 代表文章' },
] as const

export const ANOMALY_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'anomaly-manual', label: '需人工处理', description: '自动重试耗尽，需要人工处理' },
  { key: 'anomaly-retrying', label: '自动恢复', description: '技术异常正在等待或执行自动重试' },
  { key: 'anomaly-failure', label: '流程失败', description: '流程失败或技术性跳过' },
  { key: 'anomaly-filtered', label: '未达门槛', description: '评分或相关性未达到推送要求，未进入自动推送' },
  { key: 'anomaly-no-value', label: '无价值', description: 'AI 已完成分析，但内容不具备保留价值' },
  { key: 'anomaly-ad', label: '软文', description: 'AI 判定为广告或软文的文章' },
] as const

/** 人工关注是独立维度，允许与“正常/异常”重叠。 */
export const ATTENTION_FILTER_CHIPS: readonly StepFilterChip[] = [
  { key: 'ignored', label: '已忽略', description: '已从技术待办中忽略的文章，可恢复' },
  { key: 'anomaly-review', label: '待复核', description: '聚类结果存在歧义，需要人工判断' },
  { key: 'anomaly-low-confidence', label: '低分析置信', description: 'AI 分析证据把握不足，建议人工复核' },
] as const

export const STEP_FILTER_CHIPS: readonly StepFilterChip[] = [
  ...PRIMARY_FILTER_CHIPS,
  ...PROCESSING_FILTER_CHIPS,
  ...NORMAL_FILTER_CHIPS,
  ...ANOMALY_FILTER_CHIPS,
  ...ATTENTION_FILTER_CHIPS,
] as const

/** 将任意二级筛选映射回它所属的一级入口，用于保持一级高亮。 */
export function getPrimaryFilterKey(key?: FilterChipKey): FilterChipKey {
  if (!key || key === 'all') return 'all'
  if (key === 'processing-all' || key === 'normal-processing' || key === 'normal-ai' || key === 'normal-cluster' || key === 'normal-push') {
    return 'processing-all'
  }
  if (key === 'normal-all' || key === 'normal-public' || key === 'normal-not-push' || key === 'normal-pushed') {
    return 'normal-all'
  }
  if (key === 'attention-all' || key === 'anomaly-review' || key === 'anomaly-low-confidence' || key === 'ignored') {
    return 'attention-all'
  }
  return 'anomaly-all'
}

/** 用于 URL 深链的 chip 集合名（短名减小 URL 长度） */
export const URL_PARAM_CHIPS = 'chips'
export const URL_PARAM_SRC = 'src'
export const URL_PARAM_DISC = 'disc'
export const URL_PARAM_TODAY = 'today'
/** P2-1: 详情深链参数 */
export const URL_PARAM_DETAIL = 'detail'
export const URL_PARAM_DETAIL_KIND = 'detailKind'
export const URL_PARAM_TAB = 'tab'
