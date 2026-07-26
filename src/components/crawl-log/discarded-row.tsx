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
  const canRetry = isKeywordFiltered

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation()
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
    <div className="group min-w-0 overflow-hidden border-l-2 border-l-transparent px-1 py-0.5 text-[11px] leading-4 text-muted-foreground transition-colors hover:border-l-blue-500 hover:bg-blue-100/80 hover:shadow-[inset_0_1px_0_rgba(59,130,246,0.12),inset_0_-1px_0_rgba(59,130,246,0.12)]">
      <div className="flex min-w-0 flex-nowrap items-center gap-x-1">
        {pubDate && (
          <span className="shrink-0 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground/70">
            {pubDate}
          </span>
        )}
        <button
          className="min-w-0 flex-1 truncate text-left text-[12px] leading-4 text-muted-foreground group-hover:text-foreground"
          title={item.title}
          onClick={() => onOpen?.(item.id)}
        >
          {item.title}
        </button>
        <span className="shrink-0 rounded-full bg-amber-100 px-1 py-0 text-[10px] leading-4 text-amber-700">
          {label}
        </span>
        {canRetry && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            title="手动采集此文章"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
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
