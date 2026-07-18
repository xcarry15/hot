'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, ExternalLink, Loader2, RefreshCw, RotateCcw, Save, Sparkles, Square, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { ArticleDetailDto, ArticleListItemDto, ArticleListResponseDto } from '@/contracts/articles'
import type { SourceDto } from '@/contracts/sources'
import { fetchArticleDetail, fetchArticleList, reviewArticle, reviewArticles, triggerArticlesRefetch, triggerArticlesReprocess, updateArticleEditorial } from '@/features/articles-api.client'
import { fetchSources } from '@/features/sources-api.client'
import { getSnapshotValue, parseManualOverrides } from '@/lib/shared/article-calibration'
import { isRequestAborted } from '@/lib/request-json.client'
import { parseJsonArray, parseTags, splitBrands, stripHtml } from '@/lib/shared/article-codecs'

type SortMode = 'newest' | 'oldest' | 'score_desc' | 'score_asc' | 'relevance_desc' | 'relevance_asc' | 'event_desc' | 'event_asc' | 'content_desc' | 'content_asc' | 'ad_desc' | 'ad_asc' | 'confidence_desc' | 'confidence_asc'
type ViewMode = 'all' | 'attention' | 'unreviewed' | 'important' | 'general' | 'irrelevant' | 'manual'
type SortField = 'date' | 'score' | 'relevance' | 'event' | 'content' | 'ad' | 'confidence'
type NumericField = 'relevance' | 'eventScore' | 'contentScore' | 'adProbability'
type EventDetail = {
  id: string
  representativeArticleId: string | null
  representativeManual: boolean
  articleCount: number
  pushedAt: string | null
  articles: Array<{ id: string; title: string; url: string; score: number; relevance: number; reviewStatus: string; clusterStatus: string; publishedAt: string | null; createdAt: string; source: { name: string; type: string } }>
}

const PAGE_SIZE = 50
const MAX_BULK = 100
const REASONS = [
  ['low_score', '评分偏低'],
  ['ad_misclassification', '误判软文'],
  ['wrong_brand', '品牌错误'],
  ['keyword_ambiguity', '关键词歧义'],
  ['poor_summary', '摘要较差'],
] as const

function reviewLabel(status: string): string {
  return ({ unreviewed: '未归类', important: '重要', general: '一般', irrelevant: '无关' } as Record<string, string>)[status] ?? status
}

function timeLabel(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function processingLabel(item: Pick<ArticleListItemDto, 'aiStatus' | 'fetchStatus' | 'skipReason' | 'clusterStatus'>): string {
  if (item.clusterStatus === 'failed') return '聚类失败'
  if (item.clusterStatus === 'needs_review') return '聚类复核'
  if (item.fetchStatus === 'failed') return '抓取失败'
  if (item.fetchStatus === 'pending' && item.aiStatus !== 'done') return '待抓取'
  if (item.aiStatus === 'failed') return 'AI失败'
  if (item.aiStatus === 'skipped' && item.skipReason?.includes('内容不足')) return '正文不足'
  if (item.aiStatus === 'skipped') return '已跳过'
  if (item.aiStatus === 'pending') return '分析中'
  return '正常'
}

function needsAttention(item: Pick<ArticleListItemDto, 'aiStatus' | 'fetchStatus' | 'clusterStatus' | 'aiConfidence' | 'publicStatus' | 'reviewStatus'>): boolean {
  return item.fetchStatus === 'failed' || item.aiStatus === 'failed' || item.aiStatus === 'skipped' || ['failed', 'needs_review'].includes(item.clusterStatus) || (item.aiConfidence != null && item.aiConfidence < 70) || (item.publicStatus === 'published' && item.reviewStatus === 'unreviewed')
}

function verificationTone(item: ArticleListItemDto): string {
  if (item.clusterStatus === 'failed' || item.aiStatus === 'failed') return 'font-semibold text-red-700 bg-red-50'
  if (item.fetchStatus === 'failed') return 'font-semibold text-red-700 bg-red-50'
  if (item.fetchStatus === 'pending') return 'text-blue-700 bg-blue-50'
  if (item.aiStatus === 'skipped' || (item.aiConfidence != null && item.aiConfidence < 70)) return 'font-medium text-amber-700 bg-amber-50'
  if (item.aiStatus === 'pending') return 'text-blue-700 bg-blue-50'
  return 'text-muted-foreground'
}

function publicResultLabel(item: Pick<ArticleListItemDto, 'publicStatus'>): string {
  return item.publicStatus === 'published' ? '已公开' : item.publicStatus === 'revoked' ? '已撤回' : '未公开'
}

function publicReasonLabel(reason: string): string {
  return ({
    eligible: '符合公开规则',
    'ai-not-done': 'AI尚未完成',
    'source-disabled': '来源未开放公开',
    'manual-hidden': '人工隐藏',
    'score-below-threshold': '评分低于公开阈值',
    'ad-hidden': '软文规则隐藏',
    'not-publicly-eligible': '不符合公开规则',
  } as Record<string, string>)[reason] ?? '等待公开规则评估'
}

function sortValue(field: SortField, direction: 'asc' | 'desc'): SortMode {
  if (field === 'date') return direction === 'asc' ? 'oldest' : 'newest'
  return `${field}_${direction}` as SortMode
}

function SortableHeader({ label, field, sort, onSort, align = 'center' }: { label: string; field: SortField; sort: SortMode; onSort: (field: SortField) => void; align?: 'left' | 'center' }) {
  const active = sort === sortValue(field, 'asc') || sort === sortValue(field, 'desc')
  const ascending = sort === sortValue(field, 'asc')
  return <button type="button" className={`inline-flex min-w-0 items-center gap-0.5 ${align === 'left' ? 'justify-start text-left' : 'justify-center text-center'}`} onClick={() => onSort(field)} title={`按${label}排序`}><span>{label}</span>{active ? (ascending ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />) : <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />}</button>
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function IntelligenceInbox() {
  const [data, setData] = useState<ArticleListResponseDto | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ArticleDetailDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState<'review' | 'ai' | 'refetch' | null>(null)
  const [rowSavingId, setRowSavingId] = useState<string | null>(null)
  const [detailAction, setDetailAction] = useState<'review' | 'edit' | null>(null)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [reasonTags, setReasonTags] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sourceId, setSourceId] = useState('all')
  const [minScore, setMinScore] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [view, setView] = useState<ViewMode>('all')
  const [page, setPage] = useState(1)
  const [sources, setSources] = useState<SourceDto[]>([])
  const [editing, setEditing] = useState(false)
  const [showFullContent, setShowFullContent] = useState(false)
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null)
  const [eventAction, setEventAction] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [draft, setDraft] = useState({ summary: '', brand: '', category: '', tags: '', keyPoints: '' })
  const listRequestId = useRef(0)
  const rowWriteQueue = useRef<Promise<void>>(Promise.resolve())
  const rowSavingRef = useRef<string | null>(null)

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hot2-inbox-view') || '{}') as { selectedId?: string; search?: string; sourceId?: string; minScore?: string; sort?: SortMode; view?: ViewMode; page?: number }
      if (saved.selectedId) setSelectedId(saved.selectedId)
      if (typeof saved.search === 'string') { setSearch(saved.search); setSearchInput(saved.search) }
      if (saved.sourceId) setSourceId(saved.sourceId)
      if (typeof saved.minScore === 'string') setMinScore(saved.minScore)
      if (saved.sort) setSort(saved.sort)
      if (saved.view) setView(saved.view)
      if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page)
    } catch { /* 使用默认值 */ }
    setPreferencesLoaded(true)
  }, [])

  useEffect(() => { fetchSources().then(setSources).catch(() => toast.error('数据源加载失败')) }, [])

  useEffect(() => {
    if (!preferencesLoaded) return
    try { localStorage.setItem('hot2-inbox-view', JSON.stringify({ selectedId, search, sourceId, minScore, sort, view, page })) } catch { /* 本地存储不可用不影响业务 */ }
  }, [minScore, page, preferencesLoaded, search, selectedId, sort, sourceId, view])

  const loadList = useCallback(async (preferredId?: string | null) => {
    const requestId = ++listRequestId.current
    setLoading(true)
    try {
      const result = await fetchArticleList({
        page,
        pageSize: PAGE_SIZE,
        search: search.trim() || undefined,
        sourceId: sourceId === 'all' ? undefined : sourceId,
        minScore: minScore === '' ? undefined : Number(minScore),
        anomaly: view === 'attention' ? 'needs_attention' : undefined,
        reviewStatus: view === 'unreviewed' ? 'unreviewed' : ['important', 'general', 'irrelevant'].includes(view) ? view : undefined,
        manualOnly: view === 'manual',
        sort,
      })
      if (requestId !== listRequestId.current) return
      if (result.totalPages === 0 && page !== 1) {
        setPage(1)
        return
      }
      if (result.totalPages > 0 && result.page > result.totalPages) {
        setPage(result.totalPages)
        return
      }
      setData(result)
      setSelectedIds((current) => new Set([...current].filter((id) => result.items.some((item) => item.id === id))))
      setSelectedId((current) => {
        const wanted = preferredId === undefined ? current : preferredId
        return result.items.some((item) => item.id === wanted) ? wanted : result.items[0]?.id ?? null
      })
    } catch (error) {
      if (requestId !== listRequestId.current) return
      toast.error(errorMessage(error, '收件箱加载失败'))
    } finally {
      if (requestId === listRequestId.current) setLoading(false)
    }
  }, [minScore, page, search, sort, sourceId, view])

  useEffect(() => { if (preferencesLoaded) void loadList() }, [loadList, preferencesLoaded])

  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailLoading(false); return }
    const requestedId = selectedId
    const controller = new AbortController()
    setDetail(null)
    setDetailLoading(true)
    fetchArticleDetail(requestedId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.id !== requestedId) return
        setDetail(result)
        setReasonTags(parseJsonArray(result.reviewReasonTags))
        setEditing(false)
        setShowFullContent(false)
        setDraft({ summary: result.summary, brand: splitBrands(result.brand).join('，'), category: result.category, tags: parseTags(result.tags).map((tag) => tag.name).join('，'), keyPoints: parseJsonArray(result.keyPoints).join('\n') })
      })
      .catch((error) => { if (!isRequestAborted(error)) toast.error(errorMessage(error, '文章详情加载失败')) })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selectedId])

  const loadEventDetail = useCallback(async (eventId: string | null | undefined) => {
    if (!eventId) { setEventDetail(null); return }
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}`)
      if (!response.ok) throw new Error('事件详情加载失败')
      setEventDetail(await response.json() as EventDetail)
    } catch (error) {
      setEventDetail(null)
      toast.error(errorMessage(error, '事件详情加载失败'))
    }
  }, [])

  useEffect(() => { void loadEventDetail(detail?.eventId) }, [detail?.eventId, loadEventDetail])

  const setRepresentative = async (articleId: string) => {
    if (!detail?.eventId || eventAction) return
    setEventAction('representative')
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(detail.eventId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ representativeArticleId: articleId }) })
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || '指定代表文章失败')
      await Promise.all([loadEventDetail(detail.eventId), loadList(detail.id)])
      toast.success('代表文章已更新')
    } catch (error) { toast.error(errorMessage(error, '指定代表文章失败')) } finally { setEventAction(null) }
  }

  const splitArticle = async (articleId: string) => {
    if (!detail?.eventId || eventAction || (eventDetail?.articleCount ?? 0) <= 1) return
    setEventAction(`split:${articleId}`)
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(detail.eventId)}/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articleIds: [articleId] }) })
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || '拆分事件失败')
      await loadList(articleId)
      toast.success('文章已拆分为新事件，默认不会补推')
    } catch (error) { toast.error(errorMessage(error, '拆分事件失败')) } finally { setEventAction(null) }
  }

  const mergeCurrentEvent = async () => {
    if (!detail?.eventId || !mergeTargetId.trim() || eventAction) return
    setEventAction('merge')
    try {
      const response = await fetch('/api/events/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceEventId: detail.eventId, targetEventId: mergeTargetId.trim() }) })
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || '合并事件失败')
      setMergeTargetId('')
      await loadList(detail.id)
      toast.success('事件已合并，不会补推或撤回历史消息')
    } catch (error) { toast.error(errorMessage(error, '合并事件失败')) } finally { setEventAction(null) }
  }

  const visibleIds = useMemo(() => data?.items.map((item) => item.id) ?? [], [data?.items])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const pageAttentionCount = data?.items.filter(needsAttention).length ?? 0

  const patchRow = useCallback((updated: ArticleDetailDto) => {
    setData((current) => current ? { ...current, items: current.items.map((item) => item.id === updated.id ? { ...item, ...updated } : item) } : current)
    setDetail((current) => current?.id === updated.id ? updated : current)
  }, [])

  const queueRowUpdate = useCallback((id: string, input: Parameters<typeof updateArticleEditorial>[1], message: string) => {
    if (rowSavingRef.current) {
      toast.info('请等待当前修改保存完成')
      return
    }
    rowSavingRef.current = id
    setRowSavingId(id)
    rowWriteQueue.current = rowWriteQueue.current
      .then(async () => {
        const updated = await updateArticleEditorial(id, input)
        patchRow(updated)
        toast.success(message)
      })
      .catch((error) => toast.error(errorMessage(error, '更新失败')))
      .finally(() => { rowSavingRef.current = null; setRowSavingId(null) })
      .then(() => undefined)
  }, [patchRow])

  const saveEditorial = async () => {
    if (!selectedId || detail?.id !== selectedId) return
    setDetailAction('edit')
    try {
      const updated = await updateArticleEditorial(selectedId, {
        summary: draft.summary,
        brand: draft.brand,
        category: draft.category,
        tags: draft.tags.split(/[,，\n]/).map((name) => ({ name: name.trim(), tone: '中' })).filter((tag) => tag.name),
        keyPoints: draft.keyPoints.split('\n').map((item) => item.trim()).filter(Boolean),
      })
      patchRow(updated)
      setEditing(false)
      toast.success('人工纠错已保存')
    } catch (error) {
      toast.error(errorMessage(error, '保存失败'))
    } finally {
      setDetailAction(null)
    }
  }

  const reviewOne = useCallback(async (id: string, status: 'important' | 'general' | 'irrelevant', tags: string[] = []) => {
    setRowSavingId(id)
    try {
      await reviewArticle(id, status, tags)
      await loadList(id)
      if (selectedId === id) setDetail(await fetchArticleDetail(id))
      toast.success(`已归类为${reviewLabel(status)}`)
    } catch (error) {
      toast.error(errorMessage(error, '归类失败'))
    } finally {
      setRowSavingId(null)
    }
  }, [loadList, selectedId])

  const handleDetailReview = useCallback(async (status: 'important' | 'general' | 'irrelevant') => {
    if (!selectedId || detailLoading || detail?.id !== selectedId || detailAction) return
    const items = data?.items ?? []
    const index = items.findIndex((item) => item.id === selectedId)
    const nextId = index >= 0 ? items[index + 1]?.id ?? items[index - 1]?.id ?? null : null
    setDetailAction('review')
    try {
      await reviewArticle(selectedId, status, reasonTags)
      await loadList(nextId)
      toast.success(`已归类为${reviewLabel(status)}`)
    } catch (error) {
      toast.error(errorMessage(error, '归类失败'))
    } finally {
      setDetailAction(null)
    }
  }, [data?.items, detail?.id, detailAction, detailLoading, loadList, reasonTags, selectedId])

  const bulkReview = async (status: 'important' | 'general' | 'irrelevant') => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (ids.length > MAX_BULK) { toast.error(`单次最多处理 ${MAX_BULK} 篇`); return }
    setBulkLoading('review')
    try {
      const result = await reviewArticles(ids, status, [])
      setSelectedIds(new Set())
      await loadList()
      toast.success(`已批量归类 ${result.updated} 篇`)
    } catch (error) {
      toast.error(errorMessage(error, '批量归类失败'))
    } finally {
      setBulkLoading(null)
    }
  }

  const bulkAction = async (kind: 'ai' | 'refetch') => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (ids.length > MAX_BULK) { toast.error(`单次最多处理 ${MAX_BULK} 篇`); return }
    setBulkLoading(kind)
    try {
      if (kind === 'ai') {
        const result = await triggerArticlesReprocess(ids)
        if (!result.queued) throw new Error('AI 重分析任务未能启动')
        toast.success(`已将 ${ids.length} 篇文章加入 AI 重分析任务`)
      } else {
        const result = await triggerArticlesRefetch(ids)
        toast.success(`重新抓取完成：成功 ${result.processed} 篇，失败 ${result.failed} 篇`)
      }
      setSelectedIds(new Set())
      await loadList()
    } catch (error) {
      toast.error(errorMessage(error, kind === 'ai' ? '批量重新分析失败' : '批量重新抓取失败'))
    } finally {
      setBulkLoading(null)
    }
  }

  const submitSearch = () => { setPage(1); setSearch(searchInput.trim()) }
  const changeView = (value: ViewMode) => { setView(value); setPage(1); setSelectedIds(new Set()) }
  const changeSource = (value: string) => { setSourceId(value); setPage(1); setSelectedIds(new Set()) }
  const toggleSort = (field: SortField) => { setPage(1); setSort((current) => current === sortValue(field, 'desc') ? sortValue(field, 'asc') : sortValue(field, 'desc')) }
  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else if (next.size < MAX_BULK) next.add(id); else toast.error(`单次最多选择 ${MAX_BULK} 篇`); return next })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return
      const items = data?.items ?? []
      const index = selectedId ? items.findIndex((item) => item.id === selectedId) : -1
      if (event.key === 'ArrowDown' && items.length > 0) { event.preventDefault(); setSelectedId(items[Math.min(items.length - 1, index + 1)].id) }
      else if (event.key === 'ArrowUp' && items.length > 0) { event.preventDefault(); setSelectedId(items[Math.max(0, index <= 0 ? 0 : index - 1)].id) }
      else if (event.key.toLowerCase() === 'i') { event.preventDefault(); void handleDetailReview('important') }
      else if (event.key.toLowerCase() === 'g') { event.preventDefault(); void handleDetailReview('general') }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); void handleDetailReview('irrelevant') }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [data?.items, handleDetailReview, selectedId])

  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b bg-background px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><span className="text-sm font-semibold">情报收件箱</span><span className="text-xs text-muted-foreground">全量人工校准台</span>{data && <><span className="border-l pl-2 text-xs">当前结果 {data.total}</span><span className="text-xs font-medium text-amber-700">本页需关注 {pageAttentionCount}</span></>}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex min-w-56 flex-1 sm:max-w-72"><Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitSearch() }} placeholder="搜索标题、品牌或摘要" className="h-8 rounded-r-none text-xs" /><Button size="sm" variant="outline" className="h-8 rounded-l-none px-2" onClick={submitSearch}>搜索</Button></div>
        <Select value={view} onValueChange={(value) => changeView(value as ViewMode)}><SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部文章</SelectItem><SelectItem value="attention">需要关注</SelectItem><SelectItem value="unreviewed">未归类</SelectItem><SelectItem value="important">重要</SelectItem><SelectItem value="general">一般</SelectItem><SelectItem value="irrelevant">无关</SelectItem><SelectItem value="manual">人工修正</SelectItem></SelectContent></Select>
        <Select value={sourceId} onValueChange={changeSource}><SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="来源" /></SelectTrigger><SelectContent><SelectItem value="all">全部来源</SelectItem>{sources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent></Select>
        <Input value={minScore} onChange={(event) => { setMinScore(event.target.value); setPage(1) }} type="number" min={0} max={100} placeholder="最低分" className="h-8 w-20 text-xs" />
        <Select value={sort} onValueChange={(value) => { setSort(value as SortMode); setPage(1) }}><SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="newest">最新优先</SelectItem><SelectItem value="oldest">最早优先</SelectItem><SelectItem value="score_desc">高分优先</SelectItem><SelectItem value="relevance_desc">高相关优先</SelectItem><SelectItem value="ad_desc">高广告风险</SelectItem><SelectItem value="confidence_asc">低置信优先</SelectItem></SelectContent></Select>
        <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => void loadList()} aria-label="刷新"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <span className="ml-auto hidden text-[11px] text-muted-foreground xl:inline">↑↓ 切换 · I 重要 · G 一般 · N 无关</span>
      </div>
    </div>

    {selectedIds.size > 0 && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs sm:px-4"><span className="font-medium">已选 {selectedIds.size}/{MAX_BULK} 篇</span><Button size="sm" className="h-7 px-2 text-xs" disabled={bulkLoading !== null} onClick={() => void bulkReview('important')}>批量重要</Button><Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={bulkLoading !== null} onClick={() => void bulkReview('general')}>批量一般</Button><Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={bulkLoading !== null} onClick={() => void bulkReview('irrelevant')}>批量无关</Button><Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={bulkLoading !== null} onClick={() => void bulkAction('ai')}><Sparkles className="h-3 w-3" />重分析</Button><Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={bulkLoading !== null} onClick={() => void bulkAction('refetch')}><RotateCcw className="h-3 w-3" />重抓取</Button><Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={() => setSelectedIds(new Set())}>取消选择</Button></div>}

    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <ScrollArea className="h-[42%] border-b md:h-full md:w-[820px] md:shrink-0 md:border-b-0 md:border-r">
        {loading ? <div className="space-y-1 p-2">{Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div> : data?.items.length ? <div>
          <div className="sticky top-0 z-10 grid h-7 grid-cols-[18px_24px_64px_52px_minmax(96px,1fr)_58px_52px_58px_48px_34px_40px_40px_40px_40px_42px] items-center gap-1 border-b bg-muted px-2 text-[10px] font-medium text-muted-foreground"><button type="button" className="inline-flex items-center justify-center" aria-label="全选当前页" onClick={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleIds.slice(0, MAX_BULK)))}>{allVisibleSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}</button><span className="text-center">序号</span><SortableHeader label="发布时间" field="date" sort={sort} onSort={toggleSort} align="left" /><span className="text-left">来源</span><span className="text-left">标题</span><span className="text-center">核验</span><span className="text-center">内容</span><span className="text-center">公开</span><span className="text-center">归类</span><span className="text-center">总分</span><SortableHeader label="相关" field="relevance" sort={sort} onSort={toggleSort} /><SortableHeader label="事件" field="event" sort={sort} onSort={toggleSort} /><SortableHeader label="内容" field="content" sort={sort} onSort={toggleSort} /><SortableHeader label="广告" field="ad" sort={sort} onSort={toggleSort} /><SortableHeader label="置信" field="confidence" sort={sort} onSort={toggleSort} /></div>
          {data.items.map((item, index) => <InboxRow key={item.id} index={(data.page - 1) * data.pageSize + index + 1} item={item} selected={item.id === selectedId} checked={selectedIds.has(item.id)} saving={rowSavingId === item.id} onCheckedChange={() => toggleSelected(item.id)} onClick={() => setSelectedId(item.id)} onUpdate={queueRowUpdate} onReview={reviewOne} />)}
        </div> : <div className="p-8 text-center text-xs text-muted-foreground">暂无符合条件的文章</div>}
      </ScrollArea>

      <section className="min-h-0 flex-1 overflow-hidden bg-muted/10">
        {detailLoading ? <div className="space-y-4 p-5"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-5 w-1/3" /><Skeleton className="h-24 w-full" /></div> : detail ? <ScrollArea className="h-full"><div className="mx-auto max-w-4xl space-y-3 p-4 sm:p-5">
          <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"><span>{timeLabel(detail.publishedAt ?? detail.createdAt)}</span><span>{detail.source.name}</span><Badge variant="outline" className="h-5 rounded-sm px-1.5">{processingLabel(detail)}</Badge><Badge variant="outline" className="h-5 rounded-sm px-1.5">{detail.clusterStatus === 'clustered' ? `事件 · ${detail.event?.articleCount ?? 1} 来源` : detail.clusterStatus === 'needs_review' ? '事件待复核' : detail.clusterStatus === 'failed' ? '聚类失败' : '待聚类'}</Badge>{detail.event?.representativeArticleId === detail.id && <Badge variant="secondary" className="h-5 rounded-sm px-1.5">代表文章</Badge>}{parseManualOverrides(detail.manualOverrides).length > 0 && <Badge variant="secondary" className="h-5 rounded-sm px-1.5">人工修正 {parseManualOverrides(detail.manualOverrides).length} 项</Badge>}</div><h1 className="mt-1.5 text-xl font-semibold leading-snug">{detail.title}</h1></div><Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" disabled={detailAction !== null} onClick={() => setEditing((value) => !value)}>{editing ? '取消编辑' : '编辑内容'}</Button></div>
          <div className="grid grid-cols-2 border bg-background text-xs sm:grid-cols-4"><div className="border-b border-r p-2.5 sm:border-b-0"><p className="text-muted-foreground">最终总分</p><p className="mt-1 text-lg font-semibold">{detail.score}</p></div><div className="border-b border-r p-2.5 sm:border-b-0"><p className="text-muted-foreground">人工归类</p><p className="mt-1 font-semibold">{reviewLabel(detail.reviewStatus)}</p></div><div className="border-b border-r p-2.5 sm:border-b-0"><p className="text-muted-foreground">公开策略 / 结果</p><p className="mt-1 font-semibold">{detail.publicOverride === 'auto' ? '自动' : detail.publicOverride === 'public' ? '强制公开' : '强制隐藏'} · {publicResultLabel(detail)}</p></div><div className="p-2.5"><p className="text-muted-foreground">未公开原因</p><p className="mt-1 font-semibold">{detail.publicStatus === 'published' ? '—' : publicReasonLabel(detail.publicPublicationReason)}</p></div></div>
          <div className="border bg-background p-3"><p className="text-[11px] font-medium text-muted-foreground">AI 洞察</p><p className="mt-1 text-sm leading-6">{detail.summary || detail.excerpt || '暂无 AI 洞察'}</p>{parseJsonArray(detail.keyPoints).length > 0 && <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">{parseJsonArray(detail.keyPoints).slice(0, 5).map((point, index) => <li key={`${point}-${index}`}>{index + 1}. {point}</li>)}</ul>}</div>
          {eventDetail && <div className="border bg-background p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium">同事件来源 · {eventDetail.articleCount}</p>{eventDetail.pushedAt && <Badge variant="outline" className="h-5 rounded-sm px-1.5 text-[10px]">事件已推送</Badge>}<span className="ml-auto font-mono text-[10px] text-muted-foreground" title={eventDetail.id}>Event {eventDetail.id.slice(-8)}</span></div><div className="mt-2 space-y-1.5">{eventDetail.articles.map((article) => <div key={article.id} className="flex items-start gap-2 border-t pt-2 text-xs"><div className="min-w-0 flex-1"><a href={article.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium hover:text-primary hover:underline">{article.title}</a><p className="mt-0.5 text-[10px] text-muted-foreground">{article.source.name} · {article.score} 分{eventDetail.representativeArticleId === article.id ? ' · 代表文章' : ''}</p></div>{eventDetail.representativeArticleId !== article.id && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" disabled={eventAction !== null} onClick={() => void setRepresentative(article.id)}>设为代表</Button>}{eventDetail.articleCount > 1 && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-amber-700" disabled={eventAction !== null} onClick={() => void splitArticle(article.id)}>拆分</Button>}</div>)}</div><div className="mt-3 flex gap-2 border-t pt-3"><Input value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)} placeholder="目标 Event ID" className="h-7 text-xs" /><Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={!mergeTargetId.trim() || eventAction !== null} onClick={() => void mergeCurrentEvent()}>合并到目标事件</Button></div></div>}
          {editing && <div className="grid gap-3 border bg-background p-4 sm:grid-cols-2"><label className="space-y-1 text-xs">品牌<Input value={draft.brand} onChange={(event) => setDraft((value) => ({ ...value, brand: event.target.value }))} /></label><label className="space-y-1 text-xs">分类<Input value={draft.category} onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">标签（逗号分隔）<Input value={draft.tags} onChange={(event) => setDraft((value) => ({ ...value, tags: event.target.value }))} /></label><label className="space-y-1 text-xs sm:col-span-2">AI 洞察<Textarea value={draft.summary} onChange={(event) => setDraft((value) => ({ ...value, summary: event.target.value }))} className="min-h-28" /></label><label className="space-y-1 text-xs sm:col-span-2">核心要点（每行一条）<Textarea value={draft.keyPoints} onChange={(event) => setDraft((value) => ({ ...value, keyPoints: event.target.value }))} className="min-h-28" /></label><Button size="sm" className="sm:col-span-2" disabled={detailAction !== null} onClick={() => void saveEditorial()}>{detailAction === 'edit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存人工修正</Button></div>}
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><a className="inline-flex items-center gap-1 text-primary hover:underline" href={detail.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />查看原文</a><span>浏览 {detail.viewCount}</span><span>原文点击 {detail.originalClickCount}</span><span>点击率 {detail.viewCount > 0 ? Math.round(detail.originalClickCount / detail.viewCount * 100) : 0}%</span></div>
          <div className="border bg-background"><button type="button" className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-medium" onClick={() => setShowFullContent((value) => !value)}><span>正文核验</span><ChevronDown className={`h-4 w-4 transition-transform ${showFullContent ? 'rotate-180' : ''}`} /></button>{showFullContent && <div className="border-t px-4 py-3 text-sm leading-7 whitespace-pre-line">{stripHtml(detail.cleanContent).slice(0, 6000) || '正文尚未准备好'}</div>}</div>
          <div className="sticky bottom-0 border bg-background/95 p-3 shadow-sm backdrop-blur"><div className="mb-2 text-xs font-medium">人工归类</div><div className="mb-3 flex flex-wrap gap-2">{REASONS.map(([value, label]) => <label key={value} className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={reasonTags.includes(value)} onChange={(event) => setReasonTags((prev) => event.target.checked ? [...prev, value] : prev.filter((item) => item !== value))} />{label}</label>)}</div><div className="flex flex-wrap gap-2"><Button size="sm" className="h-8 bg-emerald-600 text-xs hover:bg-emerald-700" disabled={detailAction !== null} onClick={() => void handleDetailReview('important')}>{detailAction === 'review' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}重要</Button><Button size="sm" variant="outline" className="h-8 text-xs" disabled={detailAction !== null} onClick={() => void handleDetailReview('general')}>一般</Button><Button size="sm" variant="outline" className="h-8 text-xs text-muted-foreground" disabled={detailAction !== null} onClick={() => void handleDetailReview('irrelevant')}>无关</Button></div></div>
        </div></ScrollArea> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">从左侧选择一篇文章</div>}
      </section>
    </div>

    {data && data.totalPages > 1 && <div className="flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2 text-xs"><span className="mr-auto text-muted-foreground">每页 {data.pageSize} 篇，当前第 {data.page}/{data.totalPages} 页</span><Button size="sm" variant="outline" className="h-7 px-2" disabled={page <= 1 || loading} onClick={() => { setPage((value) => value - 1); setSelectedIds(new Set()) }}><ChevronLeft className="h-3.5 w-3.5" /></Button><Button size="sm" variant="outline" className="h-7 px-2" disabled={page >= data.totalPages || loading} onClick={() => { setPage((value) => value + 1); setSelectedIds(new Set()) }}><ChevronRight className="h-3.5 w-3.5" /></Button></div>}
  </div>
}

type QuickUpdate = (id: string, input: Parameters<typeof updateArticleEditorial>[1], message: string) => void

function InboxRow({ index, item, selected, checked, saving, onCheckedChange, onClick, onUpdate, onReview }: { index: number; item: ArticleListItemDto; selected: boolean; checked: boolean; saving: boolean; onCheckedChange: () => void; onClick: () => void; onUpdate: QuickUpdate; onReview: (id: string, status: 'important' | 'general' | 'irrelevant') => Promise<void> }) {
  const overrides = new Set(parseManualOverrides(item.manualOverrides))
  return <div className={`grid h-7 w-full grid-cols-[18px_24px_64px_52px_minmax(96px,1fr)_58px_52px_58px_48px_34px_40px_40px_40px_40px_42px] items-center gap-1 border-b border-l-2 px-2 text-[10px] leading-none transition-colors hover:bg-muted/60 ${selected ? 'border-l-primary bg-muted/60' : 'border-l-transparent'}`}>
    <button type="button" className="text-muted-foreground" aria-label={checked ? `取消选择 ${item.title}` : `选择 ${item.title}`} onClick={(event) => { event.stopPropagation(); onCheckedChange() }}>{checked ? <CheckSquare className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}</button>
    <span onClick={onClick} className="text-center tabular-nums text-muted-foreground">{index}</span><span onClick={onClick} className="truncate tabular-nums text-muted-foreground text-left">{timeLabel(item.publishedAt ?? item.createdAt)}</span><span onClick={onClick} className="truncate text-left text-muted-foreground" title={item.source.name}>{item.source.name}</span><span onClick={onClick} className="truncate text-left text-[11px] font-medium" title={item.title}>{item.title}</span>
    <span onClick={onClick} className={`truncate text-center ${verificationTone(item)}`} title={item.skipReason ?? undefined}>{processingLabel(item)}</span>
    <select aria-label="人工内容判断" disabled={saving} value={item.isAd ? 'ad' : 'normal'} onClick={(event) => event.stopPropagation()} onChange={(event) => onUpdate(item.id, { isAd: event.target.value === 'ad' }, event.target.value === 'ad' ? '已人工标记软文' : '已人工标记正常内容')} className={`h-5 w-full border-0 bg-transparent px-0 text-center outline-none ${overrides.has('isAd') ? 'font-semibold text-violet-700' : 'text-muted-foreground'}`}><option value="normal">正常</option><option value="ad">软文</option></select>
    <PublicCell item={item} saving={saving} onUpdate={onUpdate} />
    <select aria-label="人工归类" disabled={saving} value={item.reviewStatus} onClick={(event) => event.stopPropagation()} onChange={(event) => { if (event.target.value !== 'unreviewed') void onReview(item.id, event.target.value as 'important' | 'general' | 'irrelevant') }} className={`h-5 w-full border-0 bg-transparent px-0 text-center outline-none ${item.reviewStatus === 'unreviewed' ? 'font-semibold text-red-600' : 'font-medium'}`}><option value="unreviewed">未归类</option><option value="important">重要</option><option value="general">一般</option><option value="irrelevant">无关</option></select>
    <span className="text-center font-semibold tabular-nums" title="总分由事件分、内容分、广告概率和软文判断统一计算">{item.score}</span>
    <NumericCell item={item} field="relevance" value={item.relevance} saving={saving} onUpdate={onUpdate} />
    <NumericCell item={item} field="eventScore" value={item.eventScore} saving={saving} onUpdate={onUpdate} />
    <NumericCell item={item} field="contentScore" value={item.contentScore} saving={saving} onUpdate={onUpdate} />
    <NumericCell item={item} field="adProbability" value={item.adProbability} saving={saving} onUpdate={onUpdate} suffix="%" />
    <span className="text-center tabular-nums text-muted-foreground" title="AI 置信度只读">{item.aiConfidence == null ? '—' : `${item.aiConfidence}%`}</span>
  </div>
}

function PublicCell({ item, saving, onUpdate }: { item: ArticleListItemDto; saving: boolean; onUpdate: QuickUpdate }) {
  const value = item.publicOverride === 'public' ? 'public' : item.publicOverride === 'hidden' ? 'hidden' : 'auto'
  const tone = item.publicStatus === 'published' ? 'text-emerald-700' : item.publicStatus === 'revoked' ? 'text-amber-700' : 'text-muted-foreground'
  return <select aria-label="人工公开策略" disabled={saving} value={value} onClick={(event) => event.stopPropagation()} onChange={(event) => onUpdate(item.id, { publicOverride: event.target.value as 'auto' | 'public' | 'hidden' }, '公开策略已更新')} className={`h-5 w-full border-0 bg-transparent px-0 text-center outline-none ${tone}`} title={`实际结果：${publicResultLabel(item)}；${publicReasonLabel(item.publicPublicationReason)}`}><option value="auto">自动·{publicResultLabel(item)}</option><option value="public">公开·{publicResultLabel(item)}</option><option value="hidden">隐藏·{publicResultLabel(item)}</option></select>
}

function NumericCell({ item, field, value, saving, onUpdate, suffix = '' }: { item: ArticleListItemDto; field: NumericField; value: number | null; saving: boolean; onUpdate: QuickUpdate; suffix?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const overridden = parseManualOverrides(item.manualOverrides).includes(field)
  const aiValue = getSnapshotValue(item.aiSnapshot, field)
  useEffect(() => { if (!editing) setDraft(value == null ? '' : String(value)) }, [editing, value])
  const save = () => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next < 0 || next > 100) { toast.error('请输入 0-100 的数值'); setDraft(value == null ? '' : String(value)); return }
    setEditing(false)
    if (next !== value) onUpdate(item.id, { [field]: next }, '人工评分已更新')
  }
  if (editing) return <Input autoFocus aria-label={`编辑${field}`} disabled={saving} value={draft} type="number" min={0} max={100} onClick={(event) => event.stopPropagation()} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setEditing(false); setDraft(value == null ? '' : String(value)) } }} className="h-5 min-w-0 px-0 text-center text-[10px]" />
  return <div className="group relative flex h-5 items-center justify-center"><button type="button" disabled={saving} onClick={(event) => { event.stopPropagation(); setEditing(true) }} className={`h-5 w-full text-center tabular-nums hover:bg-muted ${overridden ? 'font-semibold text-violet-700' : 'text-muted-foreground'}`} title={overridden ? `AI 原值 ${String(aiValue ?? '暂无')}，点击编辑` : '点击人工修正'}>{value == null ? '—' : `${value}${suffix}`}</button>{overridden && aiValue !== undefined && <button type="button" disabled={saving} aria-label={`恢复${field}的AI原值`} title={`恢复 AI 原值 ${String(aiValue)}`} onClick={(event) => { event.stopPropagation(); onUpdate(item.id, { restoreFields: [field] }, '已恢复 AI 原值') }} className="absolute right-0 hidden bg-background text-violet-700 group-hover:block"><Undo2 className="h-2.5 w-2.5" /></button>}</div>
}
