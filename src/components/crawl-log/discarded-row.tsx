import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatPubDate, DISCARD_REASON_LABELS } from './helpers'
import type { DiscardedRow as DiscardedRowType } from './types'
import { retryDiscarded } from '@/features/jobs-api.client'
import {
  KEYWORD_BLACKLIST_CATEGORY,
  KEYWORD_DEFAULT_CATEGORY,
} from '@/contracts/keywords'
import { CRAWL_LOG_ROW_HOVER_CLASS } from './styles'

// ========== Discarded Row ==========

const DISCARDED_ROW_CLASS = `group min-w-0 overflow-hidden px-1 py-0.5 text-[11px] leading-4 text-muted-foreground ${CRAWL_LOG_ROW_HOVER_CLASS}`
const RETRY_BUTTON_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-none text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700'

export function DiscardedRow({
  item,
  onRetried,
  onOpen,
  keywordCategories,
  onKeywordAdded,
}: {
  item: DiscardedRowType
  onRetried?: () => void
  onOpen?: (id: string) => void
  keywordCategories?: string[]
  onKeywordAdded?: (category: string) => void
}) {
  const label = DISCARD_REASON_LABELS[item.reason] || item.reason
  const pubDate = formatPubDate(item.publishedAt || item.createdAt)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [keywordCategory, setKeywordCategory] = useState<string>(KEYWORD_DEFAULT_CATEGORY)
  const [retrying, setRetrying] = useState(false)
  const isKeywordFiltered = item.reason === 'filter:keyword'
  const categoryOptions = Array.from(new Set([
    KEYWORD_DEFAULT_CATEGORY,
    KEYWORD_BLACKLIST_CATEGORY,
    ...(keywordCategories ?? []),
  ]))

  const openRetryDialog = (e: React.MouseEvent) => {
    e.stopPropagation()
    setKeyword('')
    setKeywordCategory(KEYWORD_DEFAULT_CATEGORY)
    setDialogOpen(true)
  }

  const handleRetry = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setRetrying(true)
    try {
      const nextKeyword = keyword.trim()
      const data = await retryDiscarded(item.id, {
        keyword: nextKeyword || undefined,
        category: nextKeyword ? keywordCategory : undefined,
      })
      if (data.keyword) {
        onKeywordAdded?.(data.keyword.category)
      }
      const keywordHint = data.keyword
        ? data.keyword.added
          ? `已添加关键词「${data.keyword.word}」到「${data.keyword.category}」；`
          : `关键词「${data.keyword.word}」已在「${data.keyword.category}」；`
        : ''
      // P1-5: 区分 existing 和 created 两种结果
      if (data.existed) {
        toast.success(`${keywordHint}URL 已存在，已清理未入库记录「${data.title}」`, { duration: 3000 })
      } else {
        toast.success(`${keywordHint}已创建待处理文章「${data.title}」`, { duration: 3000 })
      }
      setDialogOpen(false)
      onRetried?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '采集失败')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className={DISCARDED_ROW_CLASS}>
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
        <span className="shrink-0 rounded-none bg-amber-100 px-1 py-0 text-[10px] leading-4 text-amber-700">
          {label}
        </span>
        {isKeywordFiltered && (
          <button
            onClick={openRetryDialog}
            disabled={retrying}
            title="手动采集此文章，可先添加关键词"
            className={RETRY_BUTTON_CLASS}
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!retrying) setDialogOpen(open) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>手动采集此文章</DialogTitle>
            <DialogDescription className="break-words">
              关键词和分组均可不填。填写后会先保存到设置中的关键词，再采集当前文章。
              <span className="mt-1 block text-foreground/80">{item.title}</span>
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRetry} className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={`manual-keyword-${item.id}`} className="text-sm font-medium">关键词（可选）</label>
              <Input
                id={`manual-keyword-${item.id}`}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="例如：首店、涨价、融资"
                disabled={retrying}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">分组</span>
              <Select value={keywordCategory} onValueChange={setKeywordCategory} disabled={retrying}>
                <SelectTrigger className="w-full" aria-label="关键词分组">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((category) => (
                    <SelectItem key={category} value={category}>{category}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={retrying}>取消</Button>
              <Button type="submit" disabled={retrying}>
                {retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {retrying ? '处理中…' : '采集此文章'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
