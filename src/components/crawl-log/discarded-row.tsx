import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatPubDate, DISCARD_REASON_LABELS } from './helpers'
import type { DiscardedRow as DiscardedRowType } from './types'
import { retryDiscarded } from '@/features/jobs-api.client'

// ========== Discarded Row ==========

export function DiscardedRow({
  item,
  onRetried,
  onOpen,
}: {
  item: DiscardedRowType
  onRetried?: () => void
  onOpen?: (id: string) => void
}) {
  const label = DISCARD_REASON_LABELS[item.reason] || item.reason
  const pubDate = formatPubDate(item.publishedAt || item.createdAt)
  const [retrying, setRetrying] = useState(false)
  const isKeywordFiltered = item.reason === 'filter:keyword'
  const isDedupSimilar = item.reason === 'dedup:near' || item.reason === 'dedup:content' || item.reason === 'dedup:entity'
  const canRetry = isKeywordFiltered || isDedupSimilar
  const matchedTitle = isDedupSimilar && item.detail
    ? (item.detail as Record<string, unknown>).matchedTitle as string | undefined
    : undefined

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation()
    // P1-5: 去重类重试需要二次确认——这是绕过判定的有副作用操作
    if (isDedupSimilar) {
      const reasonLabel = DISCARD_REASON_LABELS[item.reason] || item.reason
      const matchedInfo = matchedTitle ? `\n匹配文章: ${matchedTitle}` : ''
      const confirmed = window.confirm(
        `确认将该文章从「未入库」转为待处理？\n\n` +
        `去重原因: ${reasonLabel}${matchedInfo}\n` +
        `URL: ${item.url}\n\n` +
        `操作后将删除当前未入库记录并创建新文章。此操作不可撤销。`
      )
      if (!confirmed) return
    }
    setRetrying(true)
    try {
      const data = (await retryDiscarded(item.id)) as { title?: string; error?: string; existed?: boolean }
      if (data.error) throw new Error(data.error)
      // P1-5: 区分 existing 和 created 两种结果
      if (data.existed) {
        toast.success(`URL 已存在，已清理未入库记录「${data.title}」`, { duration: 3000 })
      } else {
        toast.success(`已创建待处理文章「${data.title}」`, { duration: 3000 })
      }
      onRetried?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '采集失败')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="group h-[22px] border-l-2 border-l-transparent text-[12px] leading-[22px] text-muted-foreground py-0 transition-colors hover:border-l-blue-500 hover:bg-blue-100/80 hover:shadow-[inset_0_1px_0_rgba(59,130,246,0.12),inset_0_-1px_0_rgba(59,130,246,0.12)]">
      <div className="flex items-center gap-1">
        {pubDate && (
          <span className="text-xs text-muted-foreground/70 shrink-0 tabular-nums font-mono">
            {pubDate}
          </span>
        )}
        <button
          className="flex-1 min-w-0 truncate text-left text-muted-foreground group-hover:text-foreground"
          title={item.title}
          onClick={() => onOpen?.(item.id)}
        >
          {item.title}
        </button>
        {matchedTitle && (
          <span className="text-xs text-red-500 shrink-0 truncate max-w-[200px]" title={`匹配: ${matchedTitle}`}>
            ←{matchedTitle}
          </span>
        )}
        <span className="shrink-0 px-1 py-0 rounded-full text-[10px] leading-5 bg-amber-100 text-amber-700">
          {label}
        </span>
        {canRetry && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            title={isKeywordFiltered ? '手动采集此文章' : '手动入库（确认非重复）'}
            className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-full text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
