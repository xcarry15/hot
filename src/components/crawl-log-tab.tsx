'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import {
  Loader2, Activity, Play, RefreshCcw, XCircle, Check, Search,
} from 'lucide-react'

import type {
  FilterState, StepFilterKey,
} from './crawl-log/types'
import type { JobSnapshot, SourceProgress } from '@/contracts/crawl-log'
import { EMPTY_FILTER_STATE, isFilterStateActive } from './crawl-log/types'
import {
  ANOMALY_FILTER_CHIPS,
  NORMAL_FILTER_CHIPS,
  PRIMARY_FILTER_CHIPS,
  REVIEW_FILTER_CHIPS,
  STEP_FILTER_CHIPS,
  type FilterChipKey,
  URL_PARAM_DETAIL,
  URL_PARAM_DETAIL_KIND,
} from './crawl-log/constants'
import type { ArticleWorkspacePanel } from '@/components/article-workspace'
import {
  applyFilterState, matchStepChip, writeFilterToUrl,
  readFilterFromCurrentUrl,
} from './crawl-log/filter'
import { SourceBlock } from './crawl-log/source-block'
import { StageButton } from './crawl-log/stage-button'
import { useCrawlLogSnapshot } from './crawl-log/use-crawl-log-snapshot'
import { EmptyState } from '@/components/ui/empty-state'
import DiscardedDetailSheet from './article-detail-sheet'
import ArticleWorkspaceDrawer from './article-workspace-drawer'
import ArticleLibrarySheet from './article-library-sheet'
import { fetchSettings, saveSettings, subscribeToSettingsChanged } from '@/features/settings-api.client'
import { fetchWorkQueueSummary } from '@/features/work-queue-api.client'
import { stopWorker, triggerCrawlStage } from '@/features/jobs-api.client'
import { triggerArticleWorkflow, updateArticleTechnicalStatus } from '@/features/articles-api.client'
import { retrySource, retrySources } from '@/features/sources-api.client'

// ========== Main Component ==========

export default function CrawlLogTab({ active = true }: { active?: boolean }) {
  const { snapshot, loading, error, refreshSnapshot } = useCrawlLogSnapshot({
    // 项目日处理量低于 200；保留一定余量即可，避免每轮传输 1000 条明细。
    limit: 250,
    enabled: active,
  })
  const sources: SourceProgress[] = useMemo(() => snapshot?.sources ?? [], [snapshot?.sources])

  const [autoCrawl, setAutoCrawl] = useState<boolean | null>(null)
  const [autoCrawlSaving, setAutoCrawlSaving] = useState(false)
  const autoCrawlSavingRef = useRef(false)
  // 惰性读取 URL，避免挂载时覆盖深链状态。
  const [filterState, setFilterState] = useState<FilterState>(() => readFilterFromCurrentUrl())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [stopLoading, setStopLoading] = useState(false)
  const [discardedDetailId, setDiscardedDetailId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [articleDetailId, setArticleDetailId] = useState<string | null>(null)
  const [articleDetailPanel, setArticleDetailPanel] = useState<ArticleWorkspacePanel | null>(null)
  const [articleDetailOpen, setArticleDetailOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryView, setLibraryView] = useState<'all' | 'attention' | 'cluster_review' | 'low_confidence'>('all')
  const [humanQueue, setHumanQueue] = useState({ total: 0, clusterReview: 0, lowConfidence: 0 })

  const refreshHumanQueue = useCallback(() => {
    fetchWorkQueueSummary(true).then((data) => setHumanQueue(data.human)).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!active) return
    refreshHumanQueue()
    const handleFocus = () => refreshHumanQueue()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [active, refreshHumanQueue])

  // 从 URL 恢复详情状态。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const syncDetailFromUrl = () => {
      const params = new URLSearchParams(window.location.search)
      const detailId = params.get(URL_PARAM_DETAIL)
      const isDiscarded = params.get(URL_PARAM_DETAIL_KIND) === 'discarded'
      const nextArticleId = params.get('articleId')
      const panel = params.get('panel')
      const openDiscarded = !nextArticleId && Boolean(detailId && isDiscarded)
      setDiscardedDetailId(openDiscarded ? detailId : null)
      setDetailOpen(openDiscarded)
      setArticleDetailId(nextArticleId)
      setArticleDetailPanel(panel === 'cluster' || panel === 'content' ? panel : null)
      setArticleDetailOpen(Boolean(nextArticleId))
    }
    syncDetailFromUrl()
    window.addEventListener('popstate', syncDetailFromUrl)
    window.addEventListener('hot2:urlchange', syncDetailFromUrl)
    return () => {
      window.removeEventListener('popstate', syncDetailFromUrl)
      window.removeEventListener('hot2:urlchange', syncDetailFromUrl)
    }
  }, [])

  const writeArticleDetailUrl = useCallback((articleId: string | null, panel?: ArticleWorkspacePanel | null) => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (articleId) url.searchParams.set('articleId', articleId)
    else url.searchParams.delete('articleId')
    if (panel) url.searchParams.set('panel', panel)
    else if (panel === null || !articleId) url.searchParams.delete('panel')
    url.searchParams.delete(URL_PARAM_DETAIL)
    url.searchParams.delete(URL_PARAM_DETAIL_KIND)
    url.searchParams.delete('tab')
    window.history.replaceState(null, '', url.toString())
  }, [])

  const openArticleWorkspace = useCallback((articleId: string, panel: ArticleWorkspacePanel) => {
    setDetailOpen(false)
    setDiscardedDetailId(null)
    setArticleDetailId(articleId)
    setArticleDetailPanel(panel)
    writeArticleDetailUrl(articleId, panel)
    setArticleDetailOpen(true)
  }, [writeArticleDetailUrl])

  const handleArticleDetailOpenChange = useCallback((open: boolean) => {
    setArticleDetailOpen(open)
    if (!open) {
      setArticleDetailId(null)
      setArticleDetailPanel(null)
      writeArticleDetailUrl(null, null)
    }
  }, [writeArticleDetailUrl])

  const handleArticleChange = useCallback((articleId: string | null, panel?: ArticleWorkspacePanel | null) => {
    setArticleDetailId(articleId)
    if (panel !== undefined) setArticleDetailPanel(panel)
    else if (!articleId) setArticleDetailPanel(null)
    setArticleDetailOpen(Boolean(articleId))
    writeArticleDetailUrl(articleId, panel)
  }, [writeArticleDetailUrl])

  // 未入库详情状态同步到 URL。
  const handleDetailOpenChange = useCallback((open: boolean) => {
    setDetailOpen(open)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (open && discardedDetailId) {
      url.searchParams.delete('articleId')
      url.searchParams.delete('panel')
      url.searchParams.set(URL_PARAM_DETAIL, discardedDetailId)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, 'discarded')
    } else {
      url.searchParams.delete(URL_PARAM_DETAIL)
      url.searchParams.delete(URL_PARAM_DETAIL_KIND)
    }
    window.history.replaceState(null, '', url.toString())
  }, [discardedDetailId])

  // 局部请求级 loading：仅用于按钮点击瞬间——成功入队 / 失败都不持久化。
  const [stageRequestLoading, setStageRequestLoading] = useState<Record<string, boolean>>({})
  const [sourceRetryLoading, setSourceRetryLoading] = useState(false)
  const [stepActionLoading, setStepActionLoading] = useState<Record<string, boolean>>({})
  const operationRequestLockRef = useRef(false)

  useEffect(() => {
    writeFilterToUrl(filterState)
  }, [filterState])

  const filterCounts = useMemo(() => {
    const counts: Partial<Record<FilterChipKey, number>> = {}
    const today = new Date().toDateString()
    for (const src of sources) {
      const articles = filterState.publishedToday
        ? src.articles.filter(article => article.publishedAt && new Date(article.publishedAt).toDateString() === today)
        : src.articles
      // “全部”展示当前快照文章总数；已忽略虽默认不展开，仍属于文章总量。
      counts.all = (counts.all ?? 0) + articles.length
      for (const a of articles) {
        for (const chip of STEP_FILTER_CHIPS) {
          if (chip.key !== 'all' && matchStepChip(a, chip.key)) {
            counts[chip.key] = (counts[chip.key] ?? 0) + 1
          }
        }
      }
    }
    return counts
  }, [sources, filterState.publishedToday])
  const failedSources = useMemo(() => sources.filter(source => source.lastRunStatus === 'failed' || source.status === 'error'), [sources])
  const failedArticles = snapshot?.technicalTotal ?? 0
  const autoRetryArticles = snapshot?.autoRetryTotal ?? 0

  // 展开/折叠偏好是纯 UI 状态：从 snapshot 派生的 expanded 字段是默认值，
  // 本地 overrides 覆盖之。
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const sourcesWithExpansion = useMemo(() => sources.map(s => ({
    ...s,
    expanded: expandedOverrides[s.id] ?? s.expanded,
  })), [sources, expandedOverrides])
  const sourceSummaryById = useMemo(
    () => new Map(sourcesWithExpansion.map(source => [source.id, source])),
    [sourcesWithExpansion],
  )
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
  const selectedFilter = filterState.chips.values().next().value as StepFilterKey | undefined
  const activePrimaryFilter: FilterChipKey = selectedFilter?.startsWith('normal-')
    ? 'normal-all'
    : selectedFilter?.startsWith('anomaly-')
      ? 'anomaly-all'
      : selectedFilter === 'ignored'
        ? 'ignored'
        : 'all'
  const secondaryFilterChips = activePrimaryFilter === 'normal-all'
    ? NORMAL_FILTER_CHIPS
    : activePrimaryFilter === 'anomaly-all'
      ? ANOMALY_FILTER_CHIPS
      : []

  // Fetch initial auto-crawl state
  useEffect(() => {
    let cancelled = false
    fetchSettings()
      .then((data: Record<string, string>) => {
        if (cancelled) return
        setAutoCrawl(data.auto_crawl_enabled === 'true')
      })
      .catch(() => { /* keep null = unknown */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => subscribeToSettingsChanged((changes) => {
    if (typeof changes.auto_crawl_enabled === 'string') {
      setAutoCrawl(changes.auto_crawl_enabled === 'true')
    }
  }), [])

  // ── 派生状态 ────────────────────────────────────────────
  // isAnyRunning 仅依赖 snapshot.activeJob——DB 是唯一事实源。
  const isAnyRunning = snapshot?.activeJob != null
  const isStageRequestPending = Object.values(stageRequestLoading).some(Boolean)
  const isStepActionPending = Object.values(stepActionLoading).some(Boolean)
  const isOperationBusy = isAnyRunning || isStageRequestPending || sourceRetryLoading || isStepActionPending
  const activeJob: JobSnapshot | null = snapshot?.activeJob ?? null
  const latestJob: JobSnapshot | null = snapshot?.latestJob ?? null

  // 当前阶段按钮的 loading 状态：activeJob.currentStage 已知 → 标记对应按钮。
  // stageRequestLoading 仅记录"用户刚点了还没返回"瞬间，不持久化。
  const stageLoading = useMemo(() => {
    const empty = { collect: false, process: false, ai: false, cluster: false, push: false, all: false }
    if (!activeJob) return empty
    const stage = activeJob.currentStage
    if (stage === 'collect') return { ...empty, collect: true, all: activeJob.type === 'full' }
    if (stage === 'process') return { ...empty, process: true, all: activeJob.type === 'full' }
    if (stage === 'ai') return { ...empty, ai: true, all: activeJob.type === 'full' }
    if (stage === 'cluster') return { ...empty, cluster: true, all: activeJob.type === 'full' }
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
        : activeJob.currentStage === 'ai' ? 'AI分析'
        : activeJob.currentStage === 'cluster' ? '事件聚类'
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
    return null
  }, [activeJob])

  const activeTaskView = useMemo(() => {
    if (!activeJob) return null
    type Stage = 'collect' | 'process' | 'ai' | 'cluster' | 'push'
    const labels: Record<Stage, string> = {
      collect: '采集',
      process: '处理',
      ai: 'AI 分析',
      cluster: '聚类',
      push: '推送',
    }
    const singleStages: Record<Stage, Stage[]> = {
      collect: ['collect'],
      process: ['process', 'ai', 'cluster'],
      cluster: ['cluster'],
      ai: ['ai', 'cluster'],
      push: ['push'],
    }
    const startStage = activeJob.workflowStartAt ?? activeJob.currentStage
    const stages: Stage[] = activeJob.activeArticleId && startStage
      ? singleStages[startStage]
      : activeJob.type === 'full'
        ? ['collect', 'process', 'ai', 'cluster', 'push']
        : activeJob.type === 'fastProcess'
          ? ['process']
          : activeJob.type === 'collect' || activeJob.type === 'process' || activeJob.type === 'ai' || activeJob.type === 'cluster' || activeJob.type === 'push'
            ? [activeJob.type]
            : []
    const currentStage = activeJob.currentStage ?? startStage
    const currentIndex = currentStage ? stages.indexOf(currentStage) : -1
    const targetArticle = activeJob.activeArticleId
      ? sources.flatMap(source => source.articles).find(article => article.id === activeJob.activeArticleId)
      : null
    const taskLabel = activeJob.activeArticleId
      ? '单篇恢复'
      : activeJob.type === 'full'
        ? '全流程'
        : `${currentStage ? labels[currentStage] : '批量'}任务`
    return {
      taskLabel,
      targetLabel: targetArticle?.title || activeJob.currentItemLabel || null,
      stages: stages.map((stage, index) => ({
        key: stage,
        label: labels[stage],
        state: index < currentIndex ? 'done' as const : index === currentIndex ? 'running' as const : 'pending' as const,
        progress: index === currentIndex
          ? { done: activeJob.progressDone, total: activeJob.progressTotal }
          : null,
      })),
      currentPosition: currentIndex >= 0 ? currentIndex + 1 : 0,
    }
  }, [activeJob, sources])

  // ── 任务头部徽标：activeJob 优先；否则根据 latestJob 显示结果；都没有显示"空闲"。
  const headerBadge = useMemo(() => {
    if (activeJob) {
      return activeJob.status === 'cancel_requested'
        ? { label: '停止中', variant: 'outline' as const, spinning: false }
        : { label: '运行中', variant: 'outline' as const, spinning: true }
    }
    if (latestJob) {
      if (latestJob.status === 'succeeded' || latestJob.status === 'completed') {
        return { label: '已完成', variant: 'secondary' as const, spinning: false }
      }
      if (latestJob.status === 'failed') {
        return { label: '失败', variant: 'destructive' as const, spinning: false }
      }
      if (latestJob.status === 'cancelled') {
        return { label: '已停止', variant: 'outline' as const, spinning: false }
      }
    }
    return { label: '空闲', variant: 'outline' as const, spinning: false }
  }, [activeJob, latestJob])

  const latestJobFailure = useMemo(() => {
    if (!latestJob || latestJob.status !== 'failed' || !latestJob.error.trim()) return null
    return latestJob.error.trim()
  }, [latestJob])

  // ── Button Handlers ──

  const handleToggleAutoCrawl = async (next: boolean) => {
    if (autoCrawlSavingRef.current) return
    const prev = autoCrawl
    autoCrawlSavingRef.current = true
    setAutoCrawl(next)
    setAutoCrawlSaving(true)
    try {
      await saveSettings({ auto_crawl_enabled: next ? 'true' : 'false' })
      toast.success(next ? '已启用自动抓取' : '已停用自动抓取', { duration: 2000 })
    } catch {
      setAutoCrawl(prev ?? true)
      toast.error('设置保存失败')
    } finally {
      autoCrawlSavingRef.current = false
      setAutoCrawlSaving(false)
    }
  }

  const handleRetrySource = async (sourceId: string) => {
    if (isOperationBusy || operationRequestLockRef.current) {
      toast.warning('当前已有任务运行，请等待完成后再重试数据源')
      return
    }
    operationRequestLockRef.current = true
    setSourceRetryLoading(true)
    try {
      const result = await retrySource(sourceId) as { queued?: boolean; error?: string }
      if (!result.queued) throw new Error(result.error || '数据源重试未能启动')
      toast.info('已触发该数据源重试')
      await refreshSnapshot()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '数据源重试触发失败')
    } finally {
      operationRequestLockRef.current = false
      setSourceRetryLoading(false)
    }
  }

  const handleRetryFailedSources = async () => {
    if (isOperationBusy || operationRequestLockRef.current || failedSources.length === 0) return
    operationRequestLockRef.current = true
    setSourceRetryLoading(true)
    try {
      const result = await retrySources(failedSources.map(source => source.id)) as { queued?: boolean; error?: string }
      if (!result.queued) throw new Error(result.error || '批量重试未能启动')
      toast.info(`已将 ${failedSources.length} 个异常源加入重试任务`)
      await refreshSnapshot()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量重试失败')
    } finally {
      operationRequestLockRef.current = false
      setSourceRetryLoading(false)
    }
  }

  const runStage = async (stage: 'all' | 'collect' | 'process' | 'ai' | 'cluster' | 'push') => {
    if (isOperationBusy || operationRequestLockRef.current) return
    if (stage === 'all' && typeof window !== 'undefined' && !window.confirm('运行全流程将依次执行采集、处理、AI 分析、事件聚类，并可能推送文章。确认继续吗？')) {
      return
    }
    operationRequestLockRef.current = true
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
        await refreshSnapshot()
      } else {
        toast.info(res.reason || res.error || '已有相同任务在执行')
      }
    } catch {
      toast.error('触发失败')
    } finally {
      operationRequestLockRef.current = false
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

  const isStepActionLoading = useCallback(
    (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => {
      if (stepActionLoading[`${articleId}:${step}`] === true) return true
      if (activeJob?.activeArticleId !== articleId) return false
      return (activeJob.currentStage ?? activeJob.workflowStartAt) === step
    },
    [activeJob, stepActionLoading],
  )

  const handleStepAction = useCallback(async (
    articleId: string,
    step: 'process' | 'cluster' | 'ai' | 'push',
  ): Promise<boolean> => {
    const key = `${articleId}:${step}`
    if (isOperationBusy || operationRequestLockRef.current || stepActionLoading[key]) return false
    operationRequestLockRef.current = true
    setStepActionLoading(prev => ({ ...prev, [key]: true }))
    try {
      const result = await triggerArticleWorkflow(articleId, step, 'retry')
      if (!result.queued) throw new Error(result.reason || '任务未能启动')
      toast.success('恢复任务已启动，可持续查看 Job 进度', { duration: 1800 })
      await refreshSnapshot()
      return true
    } catch {
      toast.error('操作失败')
      return false
    } finally {
      operationRequestLockRef.current = false
      setStepActionLoading(prev => { const next = { ...prev }; delete next[key]; return next })
    }
  }, [isOperationBusy, refreshSnapshot, stepActionLoading])

  const handleTechnicalStatus = useCallback(async (articleId: string, action: 'ignore' | 'restore') => {
    if (isOperationBusy) return
    try {
      await updateArticleTechnicalStatus(articleId, action)
      toast.success(action === 'ignore' ? '已从技术待办中忽略' : '已恢复技术待办')
      await refreshSnapshot()
    } catch {
      toast.error('操作失败')
    }
  }, [isOperationBusy, refreshSnapshot])

  const handleOpenArticle = useCallback((articleId: string) => {
    openArticleWorkspace(articleId, 'content')
  }, [openArticleWorkspace])

  const handleOpenArticlePanel = useCallback((articleId: string, panel: ArticleWorkspacePanel) => {
    openArticleWorkspace(articleId, panel)
  }, [openArticleWorkspace])

  const openLibrary = useCallback((view: typeof libraryView = 'all') => {
    setLibraryView(view)
    setLibraryOpen(true)
  }, [])

  const openArticleFromLibrary = useCallback((articleId: string) => {
    setDetailOpen(false)
    setDiscardedDetailId(null)
    setArticleDetailId(articleId)
    setArticleDetailPanel('content')
    writeArticleDetailUrl(articleId, 'content')
    setArticleDetailOpen(true)
    setLibraryOpen(false)
  }, [writeArticleDetailUrl])

  const handleLibraryChanged = useCallback(() => {
    void refreshSnapshot()
    refreshHumanQueue()
  }, [refreshHumanQueue, refreshSnapshot])

  const handleOpenDiscarded = useCallback((id: string) => {
    setArticleDetailOpen(false)
    setArticleDetailId(null)
    setArticleDetailPanel(null)
    setDiscardedDetailId(id)
    setDetailOpen(true)
    // 更新未入库详情深链。
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.delete('articleId')
      url.searchParams.delete('panel')
      url.searchParams.set(URL_PARAM_DETAIL, id)
      url.searchParams.set(URL_PARAM_DETAIL_KIND, 'discarded')
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

  const stageButtonLoading = (stage: 'all' | 'collect' | 'process' | 'ai' | 'cluster' | 'push') =>
    stageRequestLoading[stage] || stageLoading[stage]

  return (
    <div className="flex flex-col h-full">
      {/* ===== Header ===== */}
      <div className="border-b bg-muted px-3 py-2 sm:px-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <Activity className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">任务中心</span>
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

          <div className="flex items-center gap-1 flex-wrap">
          <StageButton
            label="采集"
            loading={stageButtonLoading('collect')}
            disabled={isOperationBusy}
            onClick={() => runStage('collect')}
          />
          <StageButton
            label="处理"
            loading={stageButtonLoading('process')}
            disabled={isOperationBusy}
            onClick={() => runStage('process')}
          />
          <StageButton
            label="AI分析"
            loading={stageButtonLoading('ai')}
            disabled={isOperationBusy}
            onClick={() => runStage('ai')}
          />
          <StageButton
            label="事件聚类"
            loading={stageButtonLoading('cluster')}
            disabled={isOperationBusy}
            onClick={() => runStage('cluster')}
          />
          <StageButton
            label="推送"
            loading={stageButtonLoading('push')}
            disabled={isOperationBusy}
            onClick={() => runStage('push')}
          />
          </div>

          <div className="flex-1" />

          <label className="flex items-center gap-1 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            <Switch
              checked={filterState.includeDiscarded}
              onCheckedChange={(v) => setFilterState(prev => ({ ...prev, includeDiscarded: v }))}
              aria-label="包含未入库项"
              className="scale-75"
            />
            <span>含未入库</span>
          </label>

          <label className="flex items-center gap-1 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            <Switch
              checked={filterState.publishedToday}
              onCheckedChange={(v) => setFilterState(prev => ({ ...prev, publishedToday: v }))}
              aria-label="只看今天发布的文章"
              className="scale-75"
            />
            <span>今日发布</span>
          </label>

          <label className="flex items-center gap-1 text-xs text-muted-foreground select-none cursor-pointer shrink-0">
            {autoCrawl === null ? (
              <span className="text-xs text-muted-foreground/50 italic">读取中...</span>
            ) : (
              <Switch
                checked={autoCrawl}
                onCheckedChange={handleToggleAutoCrawl}
                disabled={autoCrawlSaving}
                className="scale-75"
              />
            )}
            <span className="hidden sm:inline">自动抓取</span>
          </label>

          <Button
            size="sm"
            onClick={() => runStage('all')}
            disabled={isOperationBusy}
            className="h-7 gap-1 px-2.5 text-xs whitespace-nowrap"
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
            className="h-7 gap-1 px-2.5 text-xs whitespace-nowrap"
              aria-label="停止后台抓取"
            >
              {stopLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {stopLoading ? '停止中...' : '停止任务'}
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            className="h-7 gap-1 px-2 text-xs shrink-0"
            title="从数据库拉取真实状态,清除卡住的转圈"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {refreshing ? '刷新中...' : '刷新'}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => openLibrary('all')}
            className="h-7 gap-1 px-2 text-xs shrink-0"
            title="搜索全部历史文章"
          >
            <Search className="h-3.5 w-3.5" />
            全部文章
          </Button>
        </div>

          {/* 顶部状态与人工审核筛选；选择正常/异常后显示具体流水线状态。 */}
          <div className="flex min-w-0 w-full flex-col gap-1">
            <div
              className="flex min-w-0 items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
              role="radiogroup"
              aria-label="任务状态分类"
            >
              {PRIMARY_FILTER_CHIPS.map(chip => {
                const isAllChip = chip.key === 'all'
                const statusKey = chip.key as StepFilterKey
                const active = activePrimaryFilter === chip.key
                const n = filterCounts[chip.key] ?? 0
                return (
                  <button
                    key={chip.key}
                    onClick={() => {
                      if (isAllChip) {
                        setFilterState(prev => ({ ...prev, chips: new Set() }))
                        return
                      }
                      setFilterState(prev => ({ ...prev, chips: new Set([statusKey]) }))
                    }}
                    role="radio"
                    aria-checked={active}
                    title={chip.description}
                    className={`flex h-7 shrink-0 items-center gap-1.5 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'border-foreground bg-foreground font-medium text-background'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span>{chip.label}</span>
                    <span className={`text-[11px] tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground/70'}`}>
                      ({n})
                    </span>
                  </button>
                )
              })}
              {REVIEW_FILTER_CHIPS.map(chip => {
                const statusKey = chip.key as StepFilterKey
                const active = filterState.chips.has(statusKey)
                return (
                  <button
                    key={chip.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={chip.description}
                    onClick={() => setFilterState(prev => ({ ...prev, chips: new Set([statusKey]) }))}
                    className={`flex h-7 shrink-0 items-center gap-1.5 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'border-sky-600 bg-sky-600 font-medium text-white'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span>{chip.label}</span>
                    <span className={`text-[11px] tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground/70'}`}>
                      ({filterCounts[chip.key] ?? 0})
                    </span>
                  </button>
                )
              })}
              {isFilterStateActive(filterState) && (
                <Button size="sm" variant="ghost" onClick={() => setFilterState(EMPTY_FILTER_STATE)} className="h-7 px-2 text-xs text-muted-foreground" title="清除所有筛选">清除</Button>
              )}
            </div>

            {secondaryFilterChips.length > 0 && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-l-2 border-muted-foreground/30 pl-2 [&::-webkit-scrollbar]:hidden" role="radiogroup" aria-label="具体任务状态">
                {secondaryFilterChips.map(chip => {
                  const statusKey = chip.key as StepFilterKey
                  const active = filterState.chips.has(statusKey)
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={chip.description}
                      onClick={() => setFilterState(prev => ({ ...prev, chips: new Set([statusKey]) }))}
                      className={`h-6 shrink-0 border px-2 text-[11px] transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                    >
                      {chip.label} <span className="tabular-nums opacity-75">({filterCounts[chip.key] ?? 0})</span>
                    </button>
                  )
                })}
              </div>
            )}

          </div>

        {activeTaskView && progressView?.isRunning && (
          <div className="space-y-2 border bg-background px-3 py-2" aria-label="当前任务进度">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="font-medium">当前任务</span>
              <Badge variant="outline" className="h-5 rounded-none px-1.5 text-[10px]">{activeTaskView.taskLabel}</Badge>
              {activeTaskView.targetLabel && <span className="min-w-0 flex-1 truncate text-muted-foreground" title={activeTaskView.targetLabel}>{activeTaskView.targetLabel}</span>}
              {activeTaskView.currentPosition > 0 && <span className="shrink-0 tabular-nums text-muted-foreground">阶段 {activeTaskView.currentPosition}/{activeTaskView.stages.length}</span>}
            </div>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5 [&::-webkit-scrollbar]:hidden">
              {activeTaskView.stages.map((stage, index) => (
                <div key={stage.key} className="flex shrink-0 items-center gap-1">
                  {index > 0 && <span className="h-px w-3 bg-border" />}
                  <span
                    className={`inline-flex h-6 items-center gap-1 border px-2 text-[11px] ${
                      stage.state === 'done'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : stage.state === 'running'
                          ? 'border-blue-300 bg-blue-50 font-medium text-blue-700'
                          : 'border-border bg-muted/30 text-muted-foreground'
                    }`}
                    aria-current={stage.state === 'running' ? 'step' : undefined}
                  >
                     {stage.state === 'done' ? <Check className="h-3 w-3" /> : stage.state === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />}
                     {stage.label}
                     {stage.progress && stage.progress.total > 0 && <span className="ml-0.5 tabular-nums opacity-75">{stage.progress.done}/{stage.progress.total}</span>}
                   </span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {progressView.pct != null && <span className="w-9 shrink-0 text-right tabular-nums text-xs text-muted-foreground">{progressView.pct}%</span>}
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full bg-primary transition-[width] duration-300 ease-out ${progressView.pct == null ? 'w-1/3 animate-pulse' : ''}`}
                  style={progressView.pct == null ? undefined : { width: `${progressView.pct}%` }}
                  role="progressbar"
                  aria-valuenow={progressView.pct ?? undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="当前阶段进度"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <span className="font-medium text-blue-700">{progressView.stageLabel || '准备中'}</span>
                {progressView.errors > 0 && <span className="font-medium text-destructive">✕{progressView.errors}</span>}
              </div>
            </div>
          </div>
        )}

        {!progressView && sources.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground">
            数据源抓取时将在这里实时显示进度
          </p>
        )}
        {latestJobFailure && (
          <div className="flex min-w-0 items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="shrink-0 font-medium">任务失败</span>
            <span className="min-w-0 break-words text-destructive/90">{latestJobFailure}</span>
          </div>
        )}
        {(failedSources.length > 0 || failedArticles > 0 || autoRetryArticles > 0) && (
          <div className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-medium">异常摘要</span>
            {failedSources.length > 0 && <span>{failedSources.length} 个数据源失败</span>}
            {autoRetryArticles > 0 && <span>自动恢复中 {autoRetryArticles} 篇</span>}
            {failedArticles > 0 && <span>需人工处理 {failedArticles} 篇；当前列表已包含全部技术待办</span>}
            {failedSources.length > 0 && <Button size="sm" variant="outline" className="ml-auto h-7 border-amber-300 px-2 text-xs text-amber-900" disabled={isOperationBusy} onClick={() => void handleRetryFailedSources()}>一键重试异常源</Button>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border bg-background px-3 py-2 text-xs">
          <span className="font-medium">人工待办</span>
          <span className="text-muted-foreground">共 {humanQueue.total} 篇 · 聚类复核 {humanQueue.clusterReview} · 低分析置信 {humanQueue.lowConfidence}</span>
          <Button size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={() => openLibrary('attention')}>打开待办队列</Button>
        </div>
      </div>

      {/* ===== Source List ===== */}
      <ScrollArea className="flex-1 min-h-0 h-full" ref={scrollRef}>
        <div className="p-2 sm:p-3 space-y-1.5">
          {filteredSources.map(source => (
            <SourceBlock
              key={source.id}
              source={source}
              summarySource={sourceSummaryById.get(source.id)}
              onToggle={() => handleToggleSource(source.id)}
              onStepAction={handleStepAction}
              onStepActionLoading={isStepActionLoading}
              onTechnicalStatus={handleTechnicalStatus}
              onOpenArticle={handleOpenArticle}
              onOpenArticlePanel={handleOpenArticlePanel}
              onOpenDiscarded={handleOpenDiscarded}
              onDiscardedRetried={() => { void refreshSnapshot() }}
              onRetrySource={handleRetrySource}
              isJobRunning={isOperationBusy}
            />
          ))}

          {filteredSources.length === 0 && (
            error ? (
              <EmptyState
              title="任务中心加载失败"
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

      {/* 未入库记录保留轻量诊断；已入库文章进入当前工作台的详情抽屉。 */}
      <DiscardedDetailSheet
        discardedId={discardedDetailId}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
      />
      <ArticleLibrarySheet
        open={libraryOpen}
        initialView={libraryView}
        counts={humanQueue}
        onOpenChange={setLibraryOpen}
        onOpenArticle={openArticleFromLibrary}
      />
      <ArticleWorkspaceDrawer
        articleId={articleDetailId}
        panel={articleDetailPanel}
        open={articleDetailOpen}
        onOpenChange={handleArticleDetailOpenChange}
        onArticleChange={handleArticleChange}
        onChanged={handleLibraryChanged}
      />
    </div>
  )
}
