'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Loader2, Activity, Play, Download, FileText, Network, Bot, Send, RefreshCcw, XCircle,
} from 'lucide-react'

// ── New sub-modules ──
import type {
  FilterState, StepFilterKey,
} from './crawl-log/types'
import type { JobSnapshot, SourceProgress } from '@/contracts/crawl-log'
import { EMPTY_FILTER_STATE, isFilterStateActive } from './crawl-log/types'
import { STEP_FILTER_CHIPS, type FilterChipKey, URL_PARAM_DETAIL, URL_PARAM_DETAIL_KIND } from './crawl-log/constants'
import {
  applyFilterState, matchStepChip, writeFilterToUrl,
  readFilterFromCurrentUrl,
} from './crawl-log/filter'
import { SourceBlock } from './crawl-log/source-block'
import { StageButton } from './crawl-log/stage-button'
import { useCrawlLogSnapshot } from './crawl-log/use-crawl-log-snapshot'
import { EmptyState } from '@/components/ui/empty-state'
import ArticleDetailSheet from './article-detail-sheet'
import { fetchSettings, saveSettings } from '@/features/settings-api.client'
import {
  refetchArticle,
  reprocessArticle,
  stopWorker,
  triggerCrawlStage,
} from '@/features/jobs-api.client'
import { triggerPushArticle } from '@/features/articles-api.client'
import { retrySource, retrySources } from '@/features/sources-api.client'

// ========== Main Component ==========

export default function CrawlLogTab() {
  const { snapshot, loading, error, lastSyncedAt, refreshSnapshot } = useCrawlLogSnapshot({
    limit: 500,
  })
  const sources: SourceProgress[] = useMemo(() => snapshot?.sources ?? [], [snapshot?.sources])

  const [autoCrawl, setAutoCrawl] = useState<boolean | null>(null)
  // P2-3: 使用惰性初始化读 URL，避免 mount effect 与后续 effect 竞态清空深链。
  const [filterState, setFilterState] = useState<FilterState>(() => readFilterFromCurrentUrl())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [stopLoading, setStopLoading] = useState(false)
  const [detailArticleId, setDetailArticleId] = useState<string | null>(null)
  const [detailKind, setDetailKind] = useState<'article' | 'discarded'>('article')
  const [detailOpen, setDetailOpen] = useState(false)

  // P2-1: 从 URL 恢复详情状态
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const detailId = params.get(URL_PARAM_DETAIL)
    const detailKindParam = params.get(URL_PARAM_DETAIL_KIND) as 'article' | 'discarded' | null
    if (detailId) {
      setDetailArticleId(detailId)
      setDetailKind(detailKindParam === 'discarded' ? 'discarded' : 'article')
      setDetailOpen(true)
    }
  }, [])

  // P2-1: 详情状态变化 → URL
  const handleDetailOpenChange = useCallback((open: boolean) => {
    setDetailOpen(open)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (open && detailArticleId) {
      url.searchParams.set(URL_PARAM_DETAIL, detailArticleId)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, detailKind)
    } else {
      url.searchParams.delete(URL_PARAM_DETAIL)
      url.searchParams.delete(URL_PARAM_DETAIL_KIND)
    }
    window.history.replaceState(null, '', url.toString())
  }, [detailArticleId, detailKind])

  // 局部请求级 loading：仅用于按钮点击瞬间——成功入队 / 失败都不持久化。
  const [stageRequestLoading, setStageRequestLoading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    writeFilterToUrl(filterState)
  }, [filterState])

  const filterCounts = useMemo(() => {
    const counts: Partial<Record<FilterChipKey, number>> = {}
    const scopedSources = filterState.sourceId === 'all'
      ? sources
      : sources.filter(s => s.id === filterState.sourceId)
    for (const src of scopedSources) {
      counts.all = (counts.all ?? 0) + src.articles.length
      for (const a of src.articles || []) {
        for (const chip of STEP_FILTER_CHIPS) {
          if (chip.key !== 'all' && matchStepChip(a, chip.key)) {
            counts[chip.key] = (counts[chip.key] ?? 0) + 1
          }
        }
      }
    }
    return counts
  }, [sources, filterState.sourceId])

  const allSources = useMemo(() => sources.map(s => ({ id: s.id, name: s.name })), [sources])
  const failedSources = useMemo(() => sources.filter(source => source.lastRunStatus === 'failed' || source.status === 'error'), [sources])
  const failedArticles = useMemo(() => sources.reduce((count, source) => count + source.articles.filter(article => article.cluster === 'failed' || article.ai === 'failed' || article.process === 'failed' || article.push === 'failed').length, 0), [sources])

  // 展开/折叠偏好是纯 UI 状态：从 snapshot 派生的 expanded 字段是默认值，
  // 本地 overrides 覆盖之。
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const sourcesWithExpansion = useMemo(() => sources.map(s => ({
    ...s,
    expanded: expandedOverrides[s.id] ?? s.expanded,
  })), [sources, expandedOverrides])
  const handleToggleSource = useCallback((sourceId: string) => {
    setExpandedOverrides(prev => {
      const cur = prev[sourceId] ?? sources.find(s => s.id === sourceId)?.expanded ?? true
      return { ...prev, [sourceId]: !cur }
    })
  }, [sources])

  const filteredSources = useMemo(
    () => applyFilterState(sourcesWithExpansion, filterState),
    [sourcesWithExpansion, filterState],
  )

  // Fetch initial auto-crawl state
  useEffect(() => {
    let cancelled = false
    fetchSettings()
      .then((data: Record<string, string>) => {
        if (cancelled) return
        setAutoCrawl(data.auto_crawl_enabled !== 'false')
      })
      .catch(() => { /* keep null = unknown */ })
    return () => { cancelled = true }
  }, [])

  // ── 派生状态 ────────────────────────────────────────────
  // isAnyRunning 仅依赖 snapshot.activeJob——DB 是唯一事实源。
  const isAnyRunning = snapshot?.activeJob != null
  const activeJob: JobSnapshot | null = snapshot?.activeJob ?? null
  const latestJob: JobSnapshot | null = snapshot?.latestJob ?? null

  // 当前阶段按钮的 loading 状态：activeJob.currentStage 已知 → 标记对应按钮。
  // stageRequestLoading 仅记录"用户刚点了还没返回"瞬间，不持久化。
  const stageLoading = useMemo(() => {
    const empty = { collect: false, process: false, cluster: false, ai: false, push: false, all: false }
    if (!activeJob) return empty
    const stage = activeJob.currentStage
    if (stage === 'collect') return { ...empty, collect: true, all: activeJob.type === 'full' }
    if (stage === 'process') return { ...empty, process: true, all: activeJob.type === 'full' }
    if (stage === 'cluster') return { ...empty, cluster: true, all: activeJob.type === 'full' }
    if (stage === 'ai') return { ...empty, ai: true, all: activeJob.type === 'full' }
    if (stage === 'push') return { ...empty, push: true, all: activeJob.type === 'full' }
    return empty
  }, [activeJob])

  // 进度条数值与文案——纯派生自 activeJob；无 activeJob 时退回 latestJob 的 result。
  const progressView = useMemo(() => {
    if (activeJob) {
      const total = activeJob.progressTotal
      const done = activeJob.progressDone
      const pct = total > 0 ? Math.round((done / total) * 100) : null
      const stageLabel =
        activeJob.currentStage === 'collect' ? '采集'
        : activeJob.currentStage === 'process' ? '处理'
        : activeJob.currentStage === 'cluster' ? '事件聚类'
        : activeJob.currentStage === 'ai' ? 'AI分析'
        : activeJob.currentStage === 'push' ? '推送'
        : ''
      return {
        isRunning: true,
        pct,
        total,
        done,
        errors: activeJob.progressErrors,
        stageLabel,
        itemLabel: activeJob.currentItemLabel,
      }
    }
    // 历史结果：尝试从 latestJob.result 派生 done/errors
    if (latestJob && latestJob.result && typeof latestJob.result === 'object') {
      type StageResult = {
        processed?: number
        errors?: number
        totalSources?: number
        total?: number
      }
      const result = latestJob.result as {
        stages?: Record<string, StageResult>
        result?: StageResult
      }
      const stages = result.stages
      const stageResult = stages?.collect ?? result.result
      if (stageResult) {
        const total = stageResult.totalSources ?? stageResult.total ?? stageResult.processed ?? 0
        const done = stageResult.processed ?? (latestJob.status === 'completed' ? total : 0)
        const stageLabel = latestJob.currentStage === 'collect' ? '采集'
          : latestJob.currentStage === 'process' ? '处理'
          : latestJob.currentStage === 'cluster' ? '事件聚类'
          : latestJob.currentStage === 'ai' ? 'AI分析'
          : latestJob.currentStage === 'push' ? '推送'
          : ''
        return {
          isRunning: false,
          pct: latestJob.status === 'completed' ? 100 : null,
          total,
          done,
          errors: stageResult.errors ?? 0,
          stageLabel: stages ? '' : stageLabel,
          itemLabel: latestJob.status === 'failed' ? latestJob.error : '',
        }
      }
    }
    return null
  }, [activeJob, latestJob])

  // ── 任务头部徽标：activeJob 优先；否则根据 latestJob 显示结果；都没有显示"空闲"。
  const headerBadge = useMemo(() => {
    if (activeJob) {
      return { label: '运行中', variant: 'outline' as const, spinning: true }
    }
    if (latestJob) {
      if (latestJob.status === 'completed') {
        return { label: '已完成', variant: 'secondary' as const, spinning: false }
      }
      if (latestJob.status === 'failed') {
        return { label: '失败', variant: 'destructive' as const, spinning: false }
      }
    }
    return { label: '空闲', variant: 'outline' as const, spinning: false }
  }, [activeJob, latestJob])

  // ── Button Handlers ──

  const handleToggleAutoCrawl = async (next: boolean) => {
    const prev = autoCrawl
    setAutoCrawl(next)
    try {
      await saveSettings({ auto_crawl_enabled: next ? 'true' : 'false' })
      toast.success(next ? '已启用自动抓取' : '已停用自动抓取', { duration: 2000 })
    } catch {
      setAutoCrawl(prev ?? true)
      toast.error('设置保存失败')
    }
  }

  const handleRetrySource = async (sourceId: string) => {
    if (isAnyRunning) {
      toast.warning('当前已有任务运行，请等待完成后再重试数据源')
      return
    }
    try {
      await retrySource(sourceId)
      toast.info('已触发该数据源重试')
      void refreshSnapshot()
    } catch {
      toast.error('数据源重试触发失败')
    }
  }

  const handleRetryFailedSources = async () => {
    if (isAnyRunning || failedSources.length === 0) return
    try {
      await retrySources(failedSources.map(source => source.id))
      toast.info(`已将 ${failedSources.length} 个异常源加入重试任务`)
      void refreshSnapshot()
    } catch {
      toast.error('批量重试失败，请确认当前没有其他任务运行')
    }
  }

  const runStage = async (stage: 'all' | 'collect' | 'process' | 'cluster' | 'ai' | 'push') => {
    if (isAnyRunning) return
    if (stage === 'all' && typeof window !== 'undefined' && !window.confirm('运行全流程将依次执行采集、处理、AI 分析，并可能推送文章。确认继续吗？')) {
      return
    }
    setStageRequestLoading(prev => ({ ...prev, [stage]: true }))
    try {
      const res = (await triggerCrawlStage(stage)) as {
        queued?: boolean;
        jobId?: string;
        error?: string;
        reason?: string;
      }
      if (res.queued) {
        toast.info('任务已入队，等待调度', { duration: 1500 })
        // 服务端会 emit snapshot:changed；前端无需构造乐观状态
        void refreshSnapshot()
      } else {
        toast.info(res.reason || res.error || '已有相同任务在执行')
      }
    } catch {
      toast.error('触发失败')
    } finally {
      setStageRequestLoading(prev => ({ ...prev, [stage]: false }))
    }
  }

  const handleStopWorker = async () => {
    if (!isAnyRunning) return
    setStopLoading(true)
    try {
      await stopWorker()
      toast.info('已发送停止请求，当前阶段完成后将中断', { duration: 3000 })
      void refreshSnapshot()
    } catch {
      toast.error('停止请求失败')
    } finally {
      setStopLoading(false)
    }
  }

  // ── Per-article step actions（局部 loading，不持久化） ──

  const [stepActionLoading, setStepActionLoading] = useState<Record<string, boolean>>({})
  type StepAction = { articleId: string; step: 'process' | 'ai' | 'push'; force?: boolean; resolve: (ok: boolean) => void }
  const stepQueueRef = useRef<StepAction[]>([])
  const stepQueueRunningRef = useRef(false)
  const [stepQueueVersion, setStepQueueVersion] = useState(0)

  const isStepActionLoading = useCallback(
    (articleId: string, step: 'process' | 'ai' | 'push') =>
      stepActionLoading[`${articleId}:${step}`] === true,
    [stepActionLoading],
  )

  const executeStepAction = useCallback(async (task: Omit<StepAction, 'resolve'>): Promise<boolean> => {
    const { articleId, step, force } = task
    try {
      if (step === 'process') {
        await refetchArticle(articleId)
      } else if (step === 'ai') {
        await reprocessArticle(articleId)
      } else {
        const res = await triggerPushArticle(articleId, { force }) as { status: string; succeeded?: number; failed?: number; message?: string; success?: boolean }
        // P0-2: 区分推送结果状态，不再无条件提示成功
        const status: string = res?.status ?? (res?.success ? 'completed' : 'failed')
        if (status === 'completed') {
          toast.success('推送成功', { duration: 1500 })
        } else if (status === 'partial') {
          toast.warning(`部分推送成功（${res.succeeded ?? 0}/${(res.succeeded ?? 0) + (res.failed ?? 0)}）`, { duration: 3000 })
        } else if (status === 'no_webhooks') {
          toast.error(res?.message ?? '没有配置启用的 Webhook', { duration: 3000 })
        } else {
          toast.error(res?.message ?? '推送失败', { duration: 3000 })
        }
        void refreshSnapshot()
        return status === 'completed' || status === 'partial'
      }
      const toastLabel = step === 'process' ? '详情抓取已触发'
        : step === 'ai' ? 'AI 分析已触发'
        : '推送已触发'
      toast.success(toastLabel, { duration: 1500 })
      void refreshSnapshot()
      return true
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : 0
      if (status === 499) {
        toast.info('当前请求已取消，队列继续处理下一项', { duration: 1800 })
      } else {
        toast.error('操作失败')
      }
      return false
    }
  }, [refreshSnapshot])

  useEffect(() => {
    if (isAnyRunning || stepQueueRunningRef.current || stepQueueRef.current.length === 0) return
    stepQueueRunningRef.current = true
    const task = stepQueueRef.current.shift()!
    const key = `${task.articleId}:${task.step}`
    void executeStepAction(task).then(task.resolve, () => task.resolve(false)).finally(() => {
      setStepActionLoading(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      stepQueueRunningRef.current = false
      setStepQueueVersion(value => value + 1)
    })
  }, [executeStepAction, isAnyRunning, stepQueueVersion])

  const handleStepAction = useCallback(async (
    articleId: string,
    step: 'process' | 'ai' | 'push',
    options: { force?: boolean } = {},
  ): Promise<boolean> => {
    const key = `${articleId}:${step}`
    if (stepActionLoading[key]) return false
    const snapshotArticle = sources.flatMap(source => source.articles).find(article => article.id === articleId)
    const force = options.force ?? snapshotArticle?.push === 'filtered'
    if (step === 'push' && force && typeof window !== 'undefined'
      && !window.confirm('该操作将绕过推送阈值或重复推送保护，确认继续吗？')) return false

    setStepActionLoading(prev => ({ ...prev, [key]: true }))

    // AI 重处理现在由服务端 Job 后台执行。没有正在运行的任务或排队操作时，
    // 直接在点击事件中提交请求，避免先放入组件内存队列后因切页而丢失。
    const canSubmitAiImmediately = step === 'ai'
      && !isAnyRunning
      && !stepQueueRunningRef.current
      && stepQueueRef.current.length === 0
    if (canSubmitAiImmediately) {
      try {
        return await executeStepAction({ articleId, step, force })
      } finally {
        setStepActionLoading(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    }

    const queuedAhead = stepQueueRef.current.length + (stepQueueRunningRef.current || isAnyRunning ? 1 : 0)
    if (queuedAhead > 0) toast.info(`已加入操作队列，前方 ${queuedAhead} 项`, { duration: 1500 })
    return new Promise<boolean>(resolve => {
      stepQueueRef.current.push({ articleId, step, force, resolve })
      setStepQueueVersion(value => value + 1)
    })
  }, [executeStepAction, isAnyRunning, sources, stepActionLoading])

  const handleOpenArticle = useCallback((articleId: string) => {
    setDetailKind('article')
    setDetailArticleId(articleId)
    setDetailOpen(true)
    // P2-1: 更新 URL 深链
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set(URL_PARAM_DETAIL, articleId)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, 'article')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  const handleOpenDiscarded = useCallback((id: string) => {
    setDetailKind('discarded')
    setDetailArticleId(id)
    setDetailOpen(true)
    // P2-1: 更新 URL 深链
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set(URL_PARAM_DETAIL, id)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, 'discarded')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  const handleSelectArticle = useCallback((id: string) => {
    setDetailKind('article')
    setDetailArticleId(id)
    // P2-1: 详情内切换到另一篇文章时也更新 URL
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set(URL_PARAM_DETAIL, id)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, 'article')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const refreshed = await refreshSnapshot()
      if (!refreshed) throw new Error('refresh failed')
      toast.success(`已刷新 ${sources.length} 个数据源的状态`, { duration: 1500 })
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  // ── Render Helpers ──

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  const stageButtonLoading = (stage: 'all' | 'collect' | 'process' | 'cluster' | 'ai' | 'push') =>
    stageRequestLoading[stage] || stageLoading[stage]

  return (
    <div className="flex flex-col h-full">
      {/* ===== Header ===== */}
      <div className="px-3 py-3 sm:px-4 sm:py-4 border-b bg-muted space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <Activity className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">抓取记录</span>
          </div>

          {headerBadge.spinning ? (
            <Badge variant={headerBadge.variant} className="text-xs px-2 py-0 gap-1 border-blue-300 text-blue-700 bg-blue-50">
              <Loader2 className="h-3 w-3 animate-spin" />
              {headerBadge.label}
            </Badge>
          ) : (
            <Badge variant={headerBadge.variant} className={`text-xs px-2 py-0 ${headerBadge.label === '已完成' ? 'bg-emerald-100 text-emerald-700' : ''}`}>
              {headerBadge.label}
            </Badge>
          )}

          {lastSyncedAt != null && (
            <span className="text-[11px] text-muted-foreground font-mono hidden sm:inline">
              synced@{formatTime(lastSyncedAt)}
            </span>
          )}

          <div className="flex-1" />

          <Select
            value={filterState.sourceId}
            onValueChange={(v) => setFilterState(prev => ({ ...prev, sourceId: v }))}
          >
            <SelectTrigger
              size="sm"
              className="h-8 text-xs gap-1 min-w-[120px] max-w-[200px]"
              aria-label="数据源筛选"
            >
              <span className="text-muted-foreground">源:</span>
              <SelectValue placeholder="全部源" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部源</SelectItem>
              {allSources.map(s => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            <Switch
              checked={filterState.includeDiscarded}
              onCheckedChange={(v) => setFilterState(prev => ({ ...prev, includeDiscarded: v }))}
              aria-label="包含未入库项"
              className="scale-90"
            />
            <span>含未入库</span>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            <Switch
              checked={filterState.publishedToday}
              onCheckedChange={(v) => setFilterState(prev => ({ ...prev, publishedToday: v }))}
              aria-label="只看今天发布的文章"
              className="scale-90"
            />
            <span>今天</span>
          </label>

          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            <span className="hidden sm:inline">自动抓取</span>
            {autoCrawl === null ? (
              <span className="text-xs text-muted-foreground/50 italic">读取中...</span>
            ) : (
              <Switch
                checked={autoCrawl}
                onCheckedChange={handleToggleAutoCrawl}
              />
            )}
          </label>

          <Button
            size="sm"
            onClick={() => runStage('all')}
            disabled={isAnyRunning || stageRequestLoading['all']}
            className="h-8 gap-1.5 text-xs px-3 whitespace-nowrap"
          >
            {stageButtonLoading('all') ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {stageButtonLoading('all') ? '运行中...' : '运行全流程'}
          </Button>

          {isAnyRunning && (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleStopWorker}
              disabled={stopLoading}
              className="h-8 gap-1.5 text-xs px-3 whitespace-nowrap"
              aria-label="停止后台抓取"
            >
              {stopLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {stopLoading ? '停止中...' : '停止抓取'}
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            className="h-8 gap-1.5 text-xs px-3 shrink-0"
            title="从数据库拉取真实状态,清除卡住的转圈"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {refreshing ? '刷新中...' : '刷新'}
          </Button>
        </div>

        {/* 高级：分阶段运行 */}
        <details className="rounded-md border border-dashed px-2 py-1">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground py-1">
            分步运行
          </summary>
          <div className="flex items-center gap-2 flex-wrap pt-1">
          <StageButton
            label="采集"
            icon={Download}
            loading={stageButtonLoading('collect')}
            disabled={isAnyRunning || stageRequestLoading['collect']}
            onClick={() => runStage('collect')}
          />
          <StageButton
            label="处理"
            icon={FileText}
            loading={stageButtonLoading('process')}
            disabled={isAnyRunning || stageRequestLoading['process']}
            onClick={() => runStage('process')}
          />
          <StageButton
            label="事件聚类"
            icon={Network}
            loading={stageButtonLoading('cluster')}
            disabled={isAnyRunning || stageRequestLoading['cluster']}
            onClick={() => runStage('cluster')}
          />
          <StageButton
            label="AI分析"
            icon={Bot}
            loading={stageButtonLoading('ai')}
            disabled={isAnyRunning || stageRequestLoading['ai']}
            onClick={() => runStage('ai')}
          />
          <StageButton
            label="推送"
            icon={Send}
            loading={stageButtonLoading('push')}
            disabled={isAnyRunning || stageRequestLoading['push']}
            onClick={() => runStage('push')}
          />
          </div>
        </details>

          {/* 筛选组 — 多选 chip 横向滚动 + 源下拉 + 含未入库 + 清除 */}
          <div className="flex items-center gap-2 flex-wrap min-w-0 w-full">
            <div
              className="flex items-center gap-1 bg-muted-foreground/10 rounded-full p-1 overflow-x-auto [&::-webkit-scrollbar]:hidden min-w-0"
              role="group"
              aria-label="状态筛选（多选，任一命中即保留）"
            >
              {STEP_FILTER_CHIPS.map(chip => {
                const isAllChip = chip.key === 'all'
                const statusKey = chip.key as StepFilterKey
                const active = isAllChip
                  ? filterState.chips.size === 0
                  : filterState.chips.has(statusKey)
                const n = filterCounts[chip.key] ?? 0
                return (
                  <button
                    key={chip.key}
                    onClick={() => {
                      if (isAllChip) {
                        setFilterState(prev => ({ ...prev, chips: new Set() }))
                        return
                      }
                      setFilterState(prev => {
                        const next = new Set(prev.chips)
                        if (next.has(statusKey)) next.delete(statusKey)
                        else next.add(statusKey)
                        return { ...prev, chips: next }
                      })
                    }}
                    aria-pressed={active}
                    title={chip.description}
                    className={`text-xs px-2.5 py-1 rounded-full transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                    }`}
                  >
                    <span>{chip.label}</span>
                    <span className={`text-[11px] tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground/70'}`}>
                      ({n})
                    </span>
                  </button>
                )
              })}
            </div>

            {isFilterStateActive(filterState) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilterState(EMPTY_FILTER_STATE)}
                className="h-8 text-xs px-2 text-muted-foreground hover:text-foreground"
                title="清除所有筛选（含 URL 参数）"
              >
                清除筛选
              </Button>
            )}
          </div>

        {progressView && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width,background-color] duration-300 ease-out ${
                  progressView.isRunning ? 'bg-primary' : 'bg-emerald-500'
                } ${progressView.pct == null ? 'w-1/3 animate-pulse' : ''}`}
                style={progressView.pct == null ? undefined : { width: `${progressView.pct}%` }}
                role="progressbar"
                aria-valuenow={progressView.pct ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="抓取进度"
              />
            </div>
            <div className="flex items-center gap-3 text-xs shrink-0">
              {progressView.itemLabel && progressView.isRunning && (
                <span className="text-muted-foreground">{progressView.itemLabel}</span>
              )}
              {progressView.stageLabel && (
                <span className="text-blue-600 font-medium">{progressView.stageLabel}</span>
              )}
              {progressView.total > 0 && (
                <span className="text-muted-foreground">
                  {progressView.done}/{progressView.total}
                </span>
              )}
              {progressView.errors > 0 && (
                <span className="text-destructive font-medium">✕{progressView.errors}</span>
              )}
            </div>
          </div>
        )}

        {!progressView && sources.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground">
            数据源抓取时将在这里实时显示进度
          </p>
        )}
        {(failedSources.length > 0 || failedArticles > 0) && (
          <div className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-medium">异常摘要</span>
            {failedSources.length > 0 && <span>{failedSources.length} 个数据源失败</span>}
            {failedArticles > 0 && <span>{failedArticles} 篇文章步骤失败</span>}
            <Button size="sm" variant="outline" className="ml-auto h-7 border-amber-300 px-2 text-xs text-amber-900" disabled={isAnyRunning} onClick={() => void handleRetryFailedSources()}>一键重试异常源</Button>
          </div>
        )}
      </div>

      {/* ===== Source List ===== */}
      <ScrollArea className="flex-1 min-h-0 h-full" ref={scrollRef}>
        <div className="p-2 sm:p-3 space-y-1.5">
          {filteredSources.map(source => (
            <SourceBlock
              key={source.id}
              source={source}
              onToggle={() => handleToggleSource(source.id)}
              onStepAction={handleStepAction}
              onStepActionLoading={isStepActionLoading}
              onOpenArticle={handleOpenArticle}
              onOpenDiscarded={handleOpenDiscarded}
              onDiscardedRetried={() => { void refreshSnapshot() }}
              onRetrySource={handleRetrySource}
              isJobRunning={isAnyRunning}
            />
          ))}

          {filteredSources.length === 0 && (
            error ? (
              <EmptyState
                title="抓取记录加载失败"
                description={error}
                action={
                  <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing}>
                    重试
                  </Button>
                }
              />
            ) : isFilterStateActive(filterState) ? (
              <EmptyState
                title="当前筛选条件下无匹配文章"
                description={sources.length > 0 ? '点击「清除筛选」查看所有文章' : undefined}
                action={
                  <Button size="sm" variant="outline" onClick={() => setFilterState(EMPTY_FILTER_STATE)}>
                    清除筛选
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="等待抓取任务..."
                description="在「设置 → 源管理」中启用数据源，或点击上方「采集」按钮手动触发"
                icon={<Activity className="h-8 w-8" />}
              />
            )
          )}
        </div>
      </ScrollArea>

      {/* Article Detail Sheet */}
      <ArticleDetailSheet
        articleId={detailArticleId}
        kind={detailKind}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
        onArticleUpdated={handleRefresh}
        onSelectArticle={handleSelectArticle}
        onStepAction={handleStepAction}
        isJobRunning={isAnyRunning}
      />
    </div>
  )
}
