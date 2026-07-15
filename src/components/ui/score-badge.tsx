'use client'

import { Badge } from '@/components/ui/badge'
import { getScoreStyle } from '@/lib/shared/score-style'

export interface ScoreDetails {
  eventScore?: number | null
  contentScore?: number | null
  rawScore?: number | null
  adProbability?: number | null
  aiConfidence?: number | null
}

function scoreRow(label: string, value: number | null | undefined) {
  if (value == null) return null
  const s = getScoreStyle(value)
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold tabular-nums ${s.textOnly}`}>{value}</span>
    </div>
  )
}

function ScoreTooltip({ score, details }: { score: number; details: ScoreDetails }) {
  const s = getScoreStyle(score)
  return (
    <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs whitespace-nowrap">
        <div className="space-y-0.5">
          {scoreRow('事件影响力', details.eventScore)}
          {scoreRow('内容质量', details.contentScore)}
          {scoreRow('加权原始分', details.rawScore)}
          {scoreRow('广告概率', details.adProbability)}
          {scoreRow('AI 置信度', details.aiConfidence)}
          <div className="border-t border-slate-100 pt-0.5 mt-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">最终得分</span>
              <span className={`font-bold tabular-nums ${s.textOnly}`}>{score}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ScoreBadgeProps {
  score: number
  /** 展示风格：pill=带背景圆角徽章(列表) badge=shadcn Badge(详情) text=纯文本色(推送日志) compact=紧凑圆角(文章行) */
  variant?: 'pill' | 'badge' | 'text' | 'compact'
  /** 评分明细（hover 展开 tooltip） */
  details?: ScoreDetails
}

/**
 * 统一的评分展示组件。
 * 同一分数在所有页面渲染同一颜色（六色段位体系），各页面按需选择 variant。
 *
 * - pill: 带背景 + 文字色，rounded + font-mono（文章列表）
 * - badge: shadcn Badge 包裹 + 背景色 + 文字色 + rounded-full（文章详情）
 * - text: 纯文字色，font-mono，无背景（推送日志）
 * - compact: 带背景 + 文字色，rounded-full + px-1.5（文章行紧凑布局）
 *
 * 当传入 details 且至少一个评分字段非空时，hover 展示评分明细 tooltip。
 */
export function ScoreBadge({ score, variant = 'pill', details }: ScoreBadgeProps) {
  const s = getScoreStyle(score)
  const hasDetails = details && (
    details.eventScore != null ||
    details.contentScore != null ||
    details.rawScore != null ||
    details.adProbability != null ||
    details.aiConfidence != null
  )

  const badgeElement = variant === 'text' ? (
    <span className={`text-xs font-mono ${s.textOnly} ${hasDetails ? 'cursor-help' : ''}`}>{score}</span>
  ) : variant === 'badge' ? (
    <Badge className={`${s.bg} ${s.text} text-xs rounded-full ${hasDetails ? 'cursor-help' : ''}`}>
      {score}
    </Badge>
  ) : variant === 'compact' ? (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full tabular-nums shrink-0 ${s.bg} ${s.text} ${hasDetails ? 'cursor-help' : ''}`}>
      {score}
    </span>
  ) : (
    <span className={`text-xs font-semibold font-mono rounded px-2 py-1 ${s.bg} ${s.text} ${hasDetails ? 'cursor-help' : ''}`}>
      {score}
    </span>
  )

  if (!hasDetails) return badgeElement

  return (
    <span className="relative group shrink-0">
      {badgeElement}
      <ScoreTooltip score={score} details={details} />
    </span>
  )
}

// ========== Score Breakdown (inline) ==========

/**
 * 内联评分构成展示，用于文章详情/文章弹窗底部。
 * 以单行 flex-wrap 形式展示所有评分细分字段（事件/内容/加权/广告/置信 + 最终分）。
 */
export function ScoreBreakdown({
  score,
  eventScore,
  contentScore,
  rawScore,
  adProbability,
  aiConfidence,
}: {
  score: number
  eventScore?: number | null
  contentScore?: number | null
  rawScore?: number | null
  adProbability?: number | null
  aiConfidence?: number | null
}) {
  if (!(score > 0)) return null
  return (
    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">评分</span>
      {eventScore != null && (
        <span className={`${getScoreStyle(eventScore).textOnly}`}>事件 {eventScore}</span>
      )}
      {contentScore != null && (
        <span className={`${getScoreStyle(contentScore).textOnly}`}>内容 {contentScore}</span>
      )}
      {rawScore != null && (
        <span className={`${getScoreStyle(rawScore).textOnly}`}>加权 {rawScore}</span>
      )}
      {adProbability != null && (
        <span className={`${getScoreStyle(adProbability).textOnly}`}>广告 {adProbability}%</span>
      )}
      {aiConfidence != null && (
        <span className={`${getScoreStyle(aiConfidence).textOnly}`}>置信 {aiConfidence}%</span>
      )}
      <span className={`font-semibold ${getScoreStyle(score).textOnly}`}>最终 {score}</span>
    </div>
  )
}
