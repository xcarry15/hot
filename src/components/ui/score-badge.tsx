import { getScoreStyle } from '@/lib/shared/score-style'

interface ScoreBadgeProps {
  score: number
  /** compact-square：紧凑方角评分；meta：与公开文章元数据同字号。 */
  variant?: 'compact-square' | 'meta'
}

const COMPACT_SCORE_CLASS = 'inline-flex shrink-0 items-center justify-center rounded-none px-1 py-0 text-[11px] font-semibold leading-4 tabular-nums'
const META_SCORE_CLASS = 'inline-flex h-5 shrink-0 items-center justify-center rounded-none px-1 py-0.5 text-xs font-bold leading-4 tabular-nums sm:px-1.5'

/** 同一分数在公开页面与工作台使用同一颜色。 */
export function ScoreBadge({ score, variant = 'compact-square' }: ScoreBadgeProps) {
  const style = getScoreStyle(score)
  const layout = variant === 'meta' ? META_SCORE_CLASS : COMPACT_SCORE_CLASS
  return <span className={`${layout} ${style.bg} ${style.text}`}>{score}</span>
}
