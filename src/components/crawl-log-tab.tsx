'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import {
  Loader2, Activity,
} from 'lucide-react'

import type {
  FilterState, StepFilterKey,
} from './crawl-log/types'
import type { JobSnapshot, SourceProgress } from '@/contracts/crawl-log'
import { EMPTY_FILTER_STATE, isFilterStateActive } from './crawl-log/types'
import {
  ANOMALY_FILTER_CHIPS,
  NORMAL_FILTER_CHIPS,
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
import { CrawlLogFilters } from './crawl-log/filters-bar'
import { TaskStatusPanels } from './crawl-log/task-status-panels'
import { CrawlLogDetailSheets } from './crawl-log/detail-sheets'
import { EmptyState } from '@/components/ui/empty-state'
import { fetchSettings, saveSettings, subscribeToSettingsChanged } from '@/features/settings-api.client'
import { fetchWorkQueueSummary } from '@/features/work-queue-api.client'
import { fetchKeywordCategories } from '@/features/keywords-api.client'
import {
  KEYWORD_BLACKLIST_CATEGORY,
  KEYWORD_DEFAULT_CATEGORY,
} from '@/contracts/keywords'
import { stopWorker, triggerCrawlStage } from '@/features/jobs-api.client'
import { triggerArticleWorkflow, updateArticleTechnicalStatus } from '@/features/articles-api.client'
import { retrySource, retrySources } from '@/features/sources-api.client'

const AUTO_CRAWL_COMMIT_DELAY_MS = 5_000
type WorkflowStage = 'collect' | 'process' | 'ai' | 'cluster' | 'push'
type WorkflowAction = WorkflowStage | 'all'

const WORKFLOW_STAGES: readonly WorkflowStage[] = ['collect', 'process', 'ai', 'cluster', 'push']
const WORKFLOW_STAGE_LABELS: Record<WorkflowStage, string> = {
  collect: '采集',
  process: '处理',
  ai: 'AI',
  cluster: '聚类',
  push: '推送',
}
const WORKFLOW_SINGLE_STAGES: Record<WorkflowStage, WorkflowStage[]> = {
  collect: ['collect'],
  process: ['process', 'ai', 'cluster'],
  cluster: ['cluster'],
  ai: ['ai', 'cluster'],
  push: ['push'],
}

const WORKBENCH_STEP_BUTTON_CLASS = 'h-6 w-full px-0 text-[11px] sm:h-7 sm:w-[52px] sm:px-2 sm:text-xs'
const WORKBENCH_TOGGLE_CLASS = 'flex h-6 items-center justify-center gap-0.5 border border-border/70 bg-background/60 px-0.5 text-[10px] text-muted-foreground select-none cursor-pointer sm:h-auto sm:gap-1 sm:border-0 sm:bg-transparent sm:px-0 sm:text-xs'
const WORKBENCH_SWITCH_CLASS = 'scale-75'
const WORKBENCH_ACTION_CLASS = 'h-6 w-full gap-0.5 px-1 text-[11px] sm:h-7 sm:w-auto sm:gap-1 sm:px-2 sm:text-xs'
const WORKBENCH_PRIMARY_ACTION_CLASS = `${WORKBENCH_ACTION_CLASS} whitespace-nowrap sm:px-2.5`

// ========== Main Component ==========

export default function CrawlLogTab({ active = true }: { active?: boolean }) {
  const { snapshot, error, refreshSnapshot } = useCrawlLogSnapshot({
    // 项目日处理量低于 200；保留一定余量即可，避免每轮传输 1000 条明细。
    limit: 250,
    enabled: active,
  })
  const sources: SourceProgress[] = useMemo(() => snapshot?.sources ?? [], [snapshot?.sources])
  const [keywordCategories, setKeywordCategories] = useState<string[]>(() => Array.from(new Set([
    KEYWORD_DEFAULT_CATEGORY,
    KEYWORD_BLACKLIST_CATEGORY,
  ])))

  useEffect(() => {
    if (!active) return
    let cancelled = false
    fetchKeywordCategories()
      .then((categories) => {
        if (cancelled) return
        setKeywordCategories((current) => Array.from(new Set([...current, ...categories])))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [active])

  const handleKeywordCategoryAdded = useCallback((category: string) => {
    const normalized = category.trim()
    if (!normalized) return
    setKeywordCategories((current) => current.includes(normalized) ? current : [...current, normalized])
  }, [])

  const [autoCrawl, setAutoCrawl] = useState<boolean | null>(null)
  const [autoCrawlSaving, setAutoCrawlSaving] = useState(false)
  const autoCrawlSavingRef = useRef(false)
  const autoCrawlCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoCrawlPersistedRef = useRef<boolean | null>(null)

  useEffect(() => () => {
    if (autoCrawlCommitTimerRef.current !== null) {
      clearTimeout(autoCrawlCommitTimerRef.current)
      autoCrawlCommitTimerRef.current = null
    }
  }, [])
  // 惰性读取 URL，避免挂载时覆盖深链状态。
  const [filterState, setFilterState] = useState<FilterState>(() => readFilterFromCurrentUrl())
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

  const openArticleWorkspace = useCallback((articleId: string, panel: ArticleWorkspacePanel | null) => {
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
  const [stageRequestLoading, setStageRequestLoading] = useState<Partial<Record<WorkflowAction, boolean>>>({})
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
        const enabled = data.auto_crawl_enabled === 'true'
        autoCrawlPersistedRef.current = enabled
        setAutoCrawl(enabled)
      })
      .catch(() => { /* keep null = unknown */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => subscribeToSettingsChanged((changes) => {
    if (typeof changes.auto_crawl_enabled === 'string') {
      const enabled = changes.auto_crawl_enabled === 'true'
      autoCrawlPersistedRef.current = enabled
      if (autoCrawlCommitTimerRef.current === null && !autoCrawlSavingRef.current) {
        setAutoCrawl(enabled)
      }
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
    const empty: Record<WorkflowAction, boolean> = { collect: false, process: false, ai: false, cluster: false, push: false, all: false }
    if (!activeJob) return empty
    const stage = activeJob.currentStage
    if (stage === 'collect') return { ...empty, collect: true, all: activeJob.type === 'full' }
    if (stage === 'process') return { ...empty, process: true, all: activeJob.type === 'full' }
    if (stage === 'ai') return { ...empty, ai: true, all: activeJob.type === 'full' }
    if (stage === 'cluster') return { ...empty, cluster: true, all: activeJob.type === 'full' }
    if (stage === 'push') return { ...empty, push: true, all: activeJob.type === 'full' }
    return empty
  }, [activeJob])

  // 进度条数值与文案仅派生自 activeJob，避免从历史 Job 伪造运行进度。
  const progressView = useMemo(() => {
    if (activeJob) {
      const total = activeJob.progressTotal
      const done = activeJob.progressDone
      const pct = total > 0 ? Math.round((done / total) * 100) : null
      const stageLabel = activeJob.currentStage && activeJob.currentStage in WORKFLOW_STAGE_LABELS
        ? WORKFLOW_STAGE_LABELS[activeJob.currentStage as WorkflowStage]
        : ''
      return {
        isRunning: true,
        pct,
        errors: activeJob.progressErrors,
        stageLabel,
      }
    }
    return null
  }, [activeJob])

  const activeTaskView = useMemo(() => {
    if (!activeJob) return null
    const startStage = activeJob.workflowStartAt ?? activeJob.currentStage
    const stages: WorkflowStage[] = activeJob.activeArticleId && startStage
      ? WORKFLOW_SINGLE_STAGES[startStage]
      : activeJob.type === 'full'
        ? [...WORKFLOW_STAGES]
        : [activeJob.type]
    const currentStage = activeJob.currentStage ?? startStage
    const currentIndex = currentStage ? stages.indexOf(currentStage) : -1
    const targetArticle = activeJob.activeArticleId
      ? sources.flatMap(source => source.articles).find(article => article.id === activeJob.activeArticleId)
      : null
    const taskLabel = activeJob.activeArticleId
      ? '单篇恢复'
      : activeJob.type === 'full'
        ? '全量抓取'
        : `${currentStage ? WORKFLOW_STAGE_LABELS[currentStage as WorkflowStage] : '批量'}任务`
    return {
      taskLabel,
      targetLabel: targetArticle?.title || activeJob.currentItemLabel || null,
      stages: stages.map((stage, index) => ({
        key: stage,
        label: WORKFLOW_STAGE_LABELS[stage],
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

  const handleToggleAutoCrawl = (next: boolean) => {
    if (autoCrawlSavingRef.current) return

    if (autoCrawlCommitTimerRef.current !== null) {
      clearTimeout(autoCrawlCommitTimerRef.current)
      autoCrawlCommitTimerRef.current = null
    }

    setAutoCrawl(next)

    if (autoCrawlPersistedRef.current === next) return

    autoCrawlCommitTimerRef.current = setTimeout(() => {
      autoCrawlCommitTimerRef.current = null
      autoCrawlSavingRef.current = true
      setAutoCrawlSaving(true)
      void saveSettings({ auto_crawl_enabled: next ? 'true' : 'false' })
        .then(() => {
          autoCrawlPersistedRef.current = next
        })
        .catch(() => {
          setAutoCrawl(autoCrawlPersistedRef.current ?? !next)
          toast.error('设置保存失败')
        })
        .finally(() => {
          autoCrawlSavingRef.current = false
          setAutoCrawlSaving(false)
        })
    }, AUTO_CRAWL_COMMIT_DELAY_MS)
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

  const runStage = async (stage: WorkflowAction) => {
    if (isOperationBusy || operationRequestLockRef.current) return
    if (stage === 'all' && typeof window !== 'undefined' && !window.confirm('运行全量抓取将依次执行采集、处理、AI 分析、事件聚类，并可能推送文章。确认继续吗？')) {
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
    openArticleWorkspace(articleId, null)
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
    setArticleDetailPanel(null)
    writeArticleDetailUrl(articleId, null)
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

  const stageButtonLoading = (stage: WorkflowAction) =>
    stageRequestLoading[stage] || stageLoading[stage]

  return (
    <div className="flex h-full min-w-0 max-w-full flex-col overflow-x-hidden [&_[data-slot=button]]:rounded-none [&_[data-slot=badge]]:rounded-none">
      {/* ===== Header ===== */}
      <div className="border-b bg-muted px-2 py-1 sm:px-4 sm:py-2 space-y-1.5 sm:space-y-2">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-1 sm:flex sm:items-center sm:gap-2">
          <div className="order-1 flex min-w-0 items-center gap-2 shrink-0">
            <span className="text-sm font-semibold">任务中心</span>

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
          </div>

          <div className="order-3 col-span-2 grid w-full grid-cols-5 gap-1 sm:order-2 sm:flex sm:w-auto">
            {WORKFLOW_STAGES.map(stage => (
              <StageButton
                key={stage}
                label={WORKFLOW_STAGE_LABELS[stage]}
                loading={stageButtonLoading(stage)}
                disabled={isOperationBusy}
                onClick={() => runStage(stage)}
                className={WORKBENCH_STEP_BUTTON_CLASS}
              />
            ))}
          </div>

          <div className="hidden flex-1 sm:order-3 sm:block" />

          <div className="order-2 grid w-full grid-cols-3 gap-1 sm:order-4 sm:flex sm:w-auto sm:items-center sm:gap-2">
            <label className={WORKBENCH_TOGGLE_CLASS}>
              <Switch
                checked={filterState.includeDiscarded}
                onCheckedChange={(v) => setFilterState(prev => ({ ...prev, includeDiscarded: v }))}
                aria-label="包含未入库项"
                className={WORKBENCH_SWITCH_CLASS}
              />
              <span>未入</span>
            </label>

            <label className={WORKBENCH_TOGGLE_CLASS}>
              <Switch
                checked={filterState.publishedToday}
                onCheckedChange={(v) => setFilterState(prev => ({ ...prev, publishedToday: v }))}
                aria-label="只看今天发布的文章"
                className={WORKBENCH_SWITCH_CLASS}
              />
              <span>今日</span>
            </label>

            <label className={WORKBENCH_TOGGLE_CLASS}>
              {autoCrawl === null ? (
                <span className="text-[10px] text-muted-foreground/50 italic">读取中...</span>
              ) : (
                <Switch
                  checked={autoCrawl}
                  onCheckedChange={handleToggleAutoCrawl}
                  disabled={autoCrawlSaving}
                  className={WORKBENCH_SWITCH_CLASS}
                />
              )}
              <span>自动</span>
            </label>
          </div>

          <div className={`order-4 col-span-2 grid w-full gap-1 sm:order-5 sm:flex sm:w-auto sm:items-center sm:gap-1 ${isAnyRunning ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <Button
              size="sm"
              onClick={() => runStage('all')}
              disabled={isOperationBusy}
              className={WORKBENCH_PRIMARY_ACTION_CLASS}
            >
              <span>{stageButtonLoading('all') ? '运行中' : '全量抓取'}</span>
            </Button>

            {isAnyRunning && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleStopWorker}
                disabled={stopLoading}
                className={WORKBENCH_PRIMARY_ACTION_CLASS}
                aria-label="停止后台抓取"
              >
                <span>{stopLoading ? '停止中' : '停止'}</span>
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
              className={WORKBENCH_ACTION_CLASS}
              title="从数据库拉取真实状态,清除卡住的转圈"
            >
              <span>{refreshing ? '刷新中' : '刷新'}</span>
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => openLibrary('all')}
              className={WORKBENCH_ACTION_CLASS}
              title="搜索全部历史文章"
            >
              <span>搜索</span>
            </Button>
          </div>
        </div>

        {/* 顶部流水线状态筛选；选择正常/异常后显示具体状态。 */}
        <CrawlLogFilters
          filterState={filterState}
          setFilterState={setFilterState}
          activePrimaryFilter={activePrimaryFilter}
          secondaryFilterChips={secondaryFilterChips}
          filterCounts={filterCounts}
        />

        <TaskStatusPanels
          activeTaskView={activeTaskView}
          progressView={progressView}
          latestJobFailure={latestJobFailure}
          failedSourcesCount={failedSources.length}
          failedArticles={failedArticles}
          autoRetryArticles={autoRetryArticles}
          isOperationBusy={isOperationBusy}
          onRetryFailedSources={() => void handleRetryFailedSources()}
        />
      </div>

      {/* ===== Source List ===== */}
      {/*
       * 此处不用 Radix ScrollArea：其内部 table 包装层会按内容的固有宽度扩张，
       * 移动端的长标题会把文章行推到可视区外。原生纵向滚动可把列表宽度稳定约束在父容器内。
       */}
      <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain">
        <div className="w-full min-w-0 max-w-full space-y-1.5 p-2 sm:p-3">
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
              keywordCategories={keywordCategories}
              onKeywordAdded={handleKeywordCategoryAdded}
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
      </div>

      {/* 未入库记录保留轻量诊断；已入库文章进入当前工作台的详情抽屉。 */}
      <CrawlLogDetailSheets
        discardedDetailId={discardedDetailId}
        detailOpen={detailOpen}
        onDetailOpenChange={handleDetailOpenChange}
        libraryOpen={libraryOpen}
        libraryView={libraryView}
        humanQueue={humanQueue}
        onLibraryOpenChange={setLibraryOpen}
        onOpenArticle={openArticleFromLibrary}
        articleDetailId={articleDetailId}
        articleDetailPanel={articleDetailPanel}
        articleDetailOpen={articleDetailOpen}
        onArticleDetailOpenChange={handleArticleDetailOpenChange}
        onArticleChange={handleArticleChange}
        onChanged={handleLibraryChanged}
      />
    </div>
  )
}
