import { Check, XCircle, Loader2, Circle, Play } from 'lucide-react'
import type { StepStatus } from './types'

// ========== Step Indicator ==========

const STEP_STYLES: Record<StepStatus, { bg: string; text: string; icon: React.ReactNode }> = {
  done: {
    bg: 'bg-emerald-100',
    text: 'text-emerald-700',
    icon: <Check className="h-2.5 w-2.5" strokeWidth={3} />,
  },
  running: {
    bg: 'bg-blue-100',
    text: 'text-blue-700',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  pending: {
    bg: 'bg-amber-100',
    text: 'text-amber-800',
    icon: <Circle className="h-2.5 w-2.5" />,
  },
  failed: {
    bg: 'bg-red-100',
    text: 'text-red-700',
    icon: <XCircle className="h-2.5 w-2.5" />,
  },
  skipped: {
    bg: 'bg-slate-100',
    text: 'text-slate-500',
    icon: <Circle className="h-3 w-3 opacity-50" />,
  },
  blocked: {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    icon: <Circle className="h-3 w-3" />,
  },
  filtered: {
    bg: 'bg-slate-100',
    text: 'text-slate-500',
    icon: <Circle className="h-3 w-3 opacity-50" />,
  },
  not_applicable: {
    bg: 'bg-slate-100',
    text: 'text-slate-500',
    icon: <Circle className="h-3 w-3 opacity-50" />,
  },
}
export function StepIndicator({
  label,
  status,
  onClick,
  forceLabel,
  title,
}: {
  label: string
  status: StepStatus
  onClick?: () => void
  /** P2-8: 强制操作时的显示文案（如 filtered 状态下的"强制推送"） */
  forceLabel?: string
  /** 失败状态的补充上下文，例如自动重试时间。 */
  title?: string
}) {
  const s = STEP_STYLES[status]
  // filtered 仍允许用户手动执行；调用方会使用 force=true，绕过批量推送阈值。
  const actionable = status === 'pending'
    || status === 'failed'
    || status === 'skipped'
    || status === 'filtered'
    || status === 'done'
  const isClickable = actionable && !!onClick
  const displayLabel = forceLabel && isClickable ? forceLabel : label
  const isPushAction = label === '推送'
  const columnWidth = isPushAction ? 'w-[62px]' : label === 'AI分析' ? 'w-[58px]' : 'w-[48px]'
  const isForcePush = isPushAction && !!forceLabel && isClickable
  const isUnfinishedUnavailable = !isClickable && (
    status === 'pending'
    || status === 'blocked'
    || status === 'skipped'
    || status === 'filtered'
    || status === 'not_applicable'
  )
  // 颜色优先表达状态：完成=绿、运行=蓝、失败=红、阻塞/强制=琥珀、待处理=灰。
  // 仅普通“待推送”使用绿色无背景，表达这是可执行的正向动作。
  const pushActionStyle = !isPushAction
    ? status === 'pending'
      ? `${columnWidth} justify-center bg-amber-100 text-amber-800 hover:bg-amber-200`
      : `${columnWidth} justify-center ${s.bg} ${s.text}`
    : isForcePush
      ? 'w-[62px] justify-center bg-amber-100 text-amber-800 hover:bg-amber-200'
      : status === 'pending'
        ? 'w-[62px] justify-center bg-amber-100 text-amber-800 hover:bg-amber-200'
        : `w-[62px] justify-center ${s.bg} ${s.text}`
  const pushDisplayStyle = isPushAction
    ? isUnfinishedUnavailable
      ? 'w-[62px] justify-center bg-slate-100 text-foreground'
      : `w-[62px] justify-center ${s.bg} ${s.text}`
    : isUnfinishedUnavailable
      ? `${columnWidth} justify-center bg-slate-100 text-foreground`
      : `${columnWidth} justify-center ${s.bg} ${s.text}`

  return isClickable ? (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-5 items-center gap-0.5 rounded-none px-1.5 text-[10px] font-medium leading-5
        ${pushActionStyle}
        cursor-pointer hover:ring-1 hover:ring-primary/20 hover:brightness-95 active:scale-95 transition-[box-shadow,filter,transform] duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
      `}
      title={title || `点击执行「${displayLabel}」`}
    >
      {status === 'pending' ? (
        <Play className="h-3 w-3" strokeWidth={3} />
      ) : (
        s.icon
      )}
      {displayLabel}
    </button>
  ) : (
    <span
      className={`inline-flex h-5 items-center gap-0.5 rounded-none px-1.5 text-[10px] font-medium leading-5
        ${pushDisplayStyle}
      `}
      title={title}
    >
      {!isUnfinishedUnavailable && s.icon}
      {displayLabel}
    </span>
  )
}

// ========== Skip Badge ==========

/**
 * Map the article's free-form `summary` (used as skipReason) to a short
 * pill label. The source-of-truth strings live in dedup.ts / crawler.ts;
 * new skip reasons should add a case here when introduced.
 */
function shortSkipLabel(reason: string): string {
  if (reason.startsWith('[AI 处理失败]')) return 'AI 失败'
  if (reason === '内容不足') return '内容不足'
  if (reason.startsWith('[重复]')) {
    if (reason.includes('被更新日期的同内容文章替代')) return '旧版替换'
    if (reason.includes('实体重叠')) return '实体重叠'
    if (reason.includes('要点重叠')) return '内容重复'
    if (reason.includes('正文数值重叠') || reason.includes('报道同一事件')) return '内容重复'
    if (reason.includes('正文重叠')) return '内容重复'
    return '内容重复'
  }
  // 未知形态：截断防溢出。
  return reason.length > 8 ? `${reason.slice(0, 8)}…` : reason
}

export function SkipBadge({ reason }: { reason: string }) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 shrink-0 max-w-[120px] truncate"
      title={reason}
    >
      {shortSkipLabel(reason)}
    </span>
  )
}
