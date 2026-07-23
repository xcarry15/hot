'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { ArticleListItemDto, ArticleListResponseDto } from '@/contracts/articles'
import { cancelArticleDetailPrefetch, fetchArticleList, prefetchArticleDetail } from '@/features/articles-api.client'
import { preloadArticleWorkspace } from '@/components/article-workspace-drawer'

type QueueView = 'all' | 'attention' | 'cluster_review' | 'low_confidence'

const PAGE_SIZE = 30

function timeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(item: ArticleListItemDto): string | null {
  if (item.clusterStatus === 'needs_review') return '聚类待复核'
  if (item.aiStatus === 'done' && item.aiConfidence != null && item.aiConfidence < 70) return '低分析置信度'
  if (item.reviewStatus === 'important') return '重要'
  if (item.reviewStatus === 'general') return '一般'
  if (item.reviewStatus === 'irrelevant') return '无关'
  return null
}

export default function ArticleLibrarySheet({
  open,
  initialView = 'all',
  counts,
  onOpenChange,
  onOpenArticle,
}: {
  open: boolean
  initialView?: QueueView
  counts?: { total: number; clusterReview: number; lowConfidence: number }
  onOpenChange: (open: boolean) => void
  onOpenArticle: (articleId: string) => void
}) {
  const [view, setView] = useState<QueueView>(() => open ? initialView : 'all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ArticleListResponseDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const previousOpenRef = useRef(open)

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setView(initialView)
      setPage(1)
    }
    previousOpenRef.current = open
  }, [initialView, open])

  useEffect(() => {
    if (open && data && page > data.totalPages) {
      setPage(Math.max(1, data.totalPages))
    }
  }, [data, open, page])

  const load = useCallback(async () => {
    if (!open) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError('')
    setData(null)
    try {
      const result = await fetchArticleList({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        anomaly: view === 'attention' ? 'needs_attention' : undefined,
        clusterView: view === 'cluster_review' ? 'needs_review' : undefined,
        maxConfidence: view === 'low_confidence' ? 70 : undefined,
        sort: 'newest',
      })
      if (requestId === requestIdRef.current) setData(result)
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        setError(loadError instanceof Error ? loadError.message : '文章列表加载失败')
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [open, page, search, view])

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1
      setLoading(false)
    }
  }, [open])

  useEffect(() => () => {
    requestIdRef.current += 1
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submitSearch = () => {
    setPage(1)
    setSearch(searchInput.trim())
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 [&>[data-slot=sheet-close]]:z-10 [&>[data-slot=sheet-close]]:rounded-none [&>[data-slot=sheet-close]]:bg-background sm:max-w-2xl">
        <SheetHeader className="border-b px-4 py-3 pr-12">
          <SheetTitle className="text-base">全部文章</SheetTitle>
          <SheetDescription>搜索历史文章或进入完整人工待办队列</SheetDescription>
        </SheetHeader>
        <div className="space-y-1.5 border-b p-2.5">
          <div className="flex gap-2">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitSearch() }}
              placeholder="搜索标题、品牌或摘要"
              className="h-8 text-xs"
            />
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={submitSearch}>
              <Search className="h-3.5 w-3.5" />搜索
            </Button>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {([
              ['all', '全部文章', null],
              ['attention', '全部人工待办', counts?.total],
              ['cluster_review', '聚类复核', counts?.clusterReview],
              ['low_confidence', '低分析置信度', counts?.lowConfidence],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setView(key); setPage(1) }}
                className={`h-7 shrink-0 border px-2 text-xs ${view === key ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}{typeof count === 'number' ? ` (${count})` : ''}
              </button>
            ))}
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中</div>
          ) : error ? (
            <div className="space-y-3 p-6 text-center text-sm text-destructive"><p>{error}</p><Button size="sm" variant="outline" onClick={() => void load()}>重试</Button></div>
          ) : data?.items.length ? (
            <div className="divide-y">
              {data.items.map((item) => {
                const status = statusLabel(item)
                return <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => { preloadArticleWorkspace(); prefetchArticleDetail(item.id) }}
                  onMouseLeave={() => cancelArticleDetailPrefetch(item.id)}
                  onFocus={() => { preloadArticleWorkspace(); prefetchArticleDetail(item.id) }}
                  onBlur={() => cancelArticleDetailPrefetch(item.id)}
                  onClick={() => onOpenArticle(item.id)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60"
                >
                  <span className="w-9 shrink-0 text-sm font-semibold tabular-nums">{item.score}</span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-xs font-medium leading-5">{item.title}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">{item.source.name} · {timeLabel(item.publishedAt ?? item.createdAt)}</span>
                  </span>
                  {status && <span className="shrink-0 border px-1.5 py-0.5 text-[10px] text-muted-foreground">{status}</span>}
                </button>
              })}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">暂无符合条件的文章</div>
          )}
        </ScrollArea>
        {data && data.totalPages > 1 && (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
            <span className="mr-auto text-muted-foreground">共 {data.total} 篇 · 第 {data.page}/{data.totalPages} 页</span>
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={page >= data.totalPages || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
