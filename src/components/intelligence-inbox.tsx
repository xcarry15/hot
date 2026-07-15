'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchArticleDetail, fetchArticleList, reviewArticle } from '@/features/articles-api.client'
import type { ArticleDetailDto, ArticleListItemDto, ArticleListResponseDto } from '@/contracts/articles'
import { stripHtml } from '@/lib/shared/article-codecs'
import { ScoreBadge } from '@/components/ui/score-badge'

type ReviewFilter = 'inbox' | 'all' | 'important' | 'general' | 'irrelevant'
const REASONS = [
  ['low_score', '评分偏低'],
  ['ad_misclassification', '误判软文'],
  ['wrong_brand', '品牌错误'],
  ['keyword_ambiguity', '关键词歧义'],
  ['poor_summary', '摘要较差'],
] as const

function statusLabel(status: string): string {
  return ({ pending: '分析中', done: '已完成', failed: '分析失败', skipped: '已跳过' } as Record<string, string>)[status] ?? status
}

function reviewLabel(status: string): string {
  return ({ unreviewed: '待归类', important: '重要', general: '一般', irrelevant: '无关' } as Record<string, string>)[status] ?? status
}

function timeLabel(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function parseDedupEvidence(value: string | null): { matchedTitle?: string; matchedUrl?: string; detail?: string } {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    return {
      matchedTitle: typeof record.matchedTitle === 'string' ? record.matchedTitle : undefined,
      matchedUrl: typeof record.matchedUrl === 'string' ? record.matchedUrl : undefined,
      detail: typeof record.detail === 'string' ? record.detail : undefined,
    };
  } catch { return {}; }
}

export default function IntelligenceInbox() {
  const [data, setData] = useState<ArticleListResponseDto | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ArticleDetailDto | null>(null)
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('inbox')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reasonTags, setReasonTags] = useState<string[]>([])
  const dedupEvidence = detail ? parseDedupEvidence(detail.dedupDetail) : {}

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchArticleList({
        page,
        pageSize: 20,
        fetchStatus: 'fetched',
        inbox: reviewFilter === 'inbox',
        reviewStatus: reviewFilter !== 'inbox' && reviewFilter !== 'all' ? reviewFilter : undefined,
      })
      setData(result)
      setSelectedId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null)
    } catch {
      toast.error('收件箱加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, reviewFilter])

  useEffect(() => { void loadList() }, [loadList])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    setDetailLoading(true)
    fetchArticleDetail(selectedId)
      .then((result) => { setDetail(result); setReasonTags([]) })
      .catch(() => toast.error('文章详情加载失败'))
      .finally(() => setDetailLoading(false))
  }, [selectedId])

  const handleReview = async (status: 'important' | 'general' | 'irrelevant') => {
    if (!selectedId) return
    setReviewing(true)
    try {
      const result = await reviewArticle(selectedId, status, reasonTags)
      const payload = result as { restoredDuplicate?: boolean; aiQueued?: boolean }
      toast.success(payload.restoredDuplicate ? (payload.aiQueued ? '已恢复重复标记，AI分析已排队' : '已恢复重复标记') : `已归类为${reviewLabel(status)}`)
      await loadList()
      setDetail(null)
    } catch {
      toast.error('归类失败')
    } finally {
      setReviewing(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-4">
        <div className="mr-auto flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><span className="text-sm font-semibold">情报收件箱</span>{data && <span className="text-xs text-muted-foreground">{data.total} 篇</span>}</div>
        <Select value={reviewFilter} onValueChange={(value) => { setReviewFilter(value as ReviewFilter); setPage(1) }}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="inbox">待归类</SelectItem><SelectItem value="all">全部已处理</SelectItem><SelectItem value="important">重要</SelectItem><SelectItem value="general">一般</SelectItem><SelectItem value="irrelevant">无关</SelectItem></SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => void loadList()} aria-label="刷新收件箱"><RefreshCw className="h-3.5 w-3.5" /></Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ScrollArea className="h-[42%] border-b md:h-full md:w-[360px] md:shrink-0 md:border-b-0 md:border-r">
          {loading ? <div className="space-y-2 p-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div> : data?.items.length ? (
            <div className="divide-y">
              {data.items.map((item) => <InboxRow key={item.id} item={item} selected={item.id === selectedId} onClick={() => setSelectedId(item.id)} />)}
            </div>
          ) : <div className="p-8 text-center text-xs text-muted-foreground">{reviewFilter === 'inbox' ? '暂无待归类文章' : '暂无文章'}</div>}
        </ScrollArea>

        <section className="min-h-0 flex-1 overflow-hidden bg-muted/10">
          {detailLoading ? <div className="space-y-4 p-5"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-5 w-1/3" /><Skeleton className="h-24 w-full" /></div> : detail ? (
            <ScrollArea className="h-full"><div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{timeLabel(detail.publishedAt ?? detail.createdAt)}</span><span>|</span><span>{detail.source.name}</span><Badge variant="outline">{statusLabel(detail.aiStatus)}</Badge><Badge variant="outline">{reviewLabel(detail.reviewStatus)}</Badge>{detail.duplicateStatus === 'duplicate' && <Badge variant="destructive">重复</Badge>}<ScoreBadge score={detail.score} /></div>
              <h1 className="text-xl font-semibold leading-snug">{detail.title}</h1>
              {detail.summary && <div className="border-l-2 border-primary/50 bg-background p-3 text-sm leading-relaxed">{detail.summary}</div>}
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>相关度 {detail.relevance}</span>{detail.isAd && <Badge variant="destructive">软文</Badge>}{detail.pushedAt && <Badge variant="outline">已推送</Badge>}<a className="inline-flex items-center gap-1 text-primary hover:underline" href={detail.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />原文</a></div>
              <div className="rounded-md border bg-background p-4 text-sm leading-7 whitespace-pre-line">{stripHtml(detail.cleanContent).slice(0, 6000) || '正文尚未准备好'}</div>
              {detail.duplicateStatus === 'duplicate' && <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 space-y-1"><p>该文章被标记为重复，默认跳过完整 AI。</p>{dedupEvidence.matchedTitle && <p className="truncate">关联原文：{dedupEvidence.matchedTitle}</p>}{dedupEvidence.detail && <p>{dedupEvidence.detail}</p>}{dedupEvidence.matchedUrl && <a href={dedupEvidence.matchedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="h-3 w-3" />查看关联原文</a>}<Button size="sm" variant="outline" className="mt-1 h-7 px-2 text-[11px]" disabled={reviewing} onClick={() => void handleReview('important')}>取消重复并分析</Button></div></div>}
              <div className="sticky bottom-0 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur">
                <div className="mb-2 text-xs font-medium">快速归类（完成后自动进入下一篇）</div>
                <div className="mb-3 flex flex-wrap gap-2">{REASONS.map(([value, label]) => <label key={value} className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={reasonTags.includes(value)} onChange={(event) => setReasonTags((prev) => event.target.checked ? [...prev, value] : prev.filter((item) => item !== value))} />{label}</label>)}</div>
                <div className="flex flex-wrap gap-2"><Button size="sm" className="h-8 bg-emerald-600 text-xs hover:bg-emerald-700" disabled={reviewing} onClick={() => void handleReview('important')}>{reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}重要</Button><Button size="sm" variant="outline" className="h-8 text-xs" disabled={reviewing} onClick={() => void handleReview('general')}>一般</Button><Button size="sm" variant="outline" className="h-8 text-xs text-muted-foreground" disabled={reviewing} onClick={() => void handleReview('irrelevant')}>无关</Button></div>
              </div>
            </div></ScrollArea>
          ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">从左侧选择一篇文章</div>}
        </section>
      </div>

      {data && data.totalPages > 1 && <div className="flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2 text-xs"><span className="text-muted-foreground">第 {data.page}/{data.totalPages} 页</span><Button size="sm" variant="outline" className="h-7 px-2" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button><Button size="sm" variant="outline" className="h-7 px-2" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button></div>}
    </div>
  )
}

function InboxRow({ item, selected, onClick }: { item: ArticleListItemDto; selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`w-full border-l-2 px-3 py-3 text-left transition-colors hover:bg-muted/60 ${selected ? 'border-primary bg-muted/60' : 'border-transparent'}`}><div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span>{timeLabel(item.createdAt)}</span><span className="truncate">{item.source.name}</span><span className="ml-auto shrink-0">{statusLabel(item.aiStatus)}</span></div><div className="mt-1 flex items-start gap-2"><span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">{item.title}</span><ScoreBadge score={item.score} variant="compact" /></div><div className="mt-1 flex gap-1">{item.isAd && <Badge variant="destructive" className="h-4 px-1 text-[10px]">软文</Badge>}{item.duplicateStatus === 'duplicate' && <Badge variant="outline" className="h-4 px-1 text-[10px]">重复</Badge>}</div></button>
}
