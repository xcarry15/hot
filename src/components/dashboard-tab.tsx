'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  fetchDashboardAnalytics,
  fetchFeedbackSuggestions,
  generateFeedbackSuggestions,
  updateFeedbackSuggestion,
  type FeedbackSuggestion,
  type DashboardAnalytics,
  type DashboardAnalyticsRange,
} from '@/features/dashboard-api.client'
import { Skeleton } from '@/components/ui/skeleton'
import PushLogPanel from '@/components/push-log-panel'
import {
  HelpCircle,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { CrawlTimeCard, DailyNewArticlesCard, DailyPublicArticlesCard, DailyPushedArticlesCard, TopViewedArticlesCard } from './dashboard/dashboard-cards'
import { isRequestAborted } from '@/lib/request-json.client'

type SourceSort = 'found' | 'totalArticles' | 'avgScore' | 'ingested' | 'processed' | 'analyzed' | 'pushed' | 'unmatched' | 'duplicates' | 'ads'

const RANGE_OPTIONS: Array<{ value: DashboardAnalyticsRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 1 周' },
  { value: '30d', label: '近 30 天' },
]

const SOURCE_FIELD_HELP: Record<string, { formula: string; detail: string }> = {
  '数据源': { formula: '配置的抓取来源名称', detail: 'RSS 订阅源或网站抓取规则' },
  '发现': { formula: '抓取任务中发现的总文章数', detail: '每次抓取发现的原始文章数量，包含重复和软文' },
  '文章总数': { formula: '已入库数 + 未入库数', detail: '已入库文章与关键词未命中、重复而未入库文章的总数' },
  '平均分': { formula: 'AI 分析分数之和 ÷ AI 分析文章数', detail: '仅统计 AI 已完成分析的文章，满分100' },
  '入库': { formula: '去重后入库的文章数', detail: '经去重（重复、已推送）后进入处理流程的文章数' },
  '处理': { formula: '完成预处理的文章数', detail: '经过预处理流程的文章数（不含入库前去重）' },
  'AI分析': { formula: 'AI 完成分析的文章数', detail: '所有 AI 已完成的文章，软文是其中的子集' },
  '推送': { formula: '推送数 ÷ 文章总数', detail: '成功推送到飞书的文章数及其在全部文章中的占比' },
  '未命中': { formula: '未命中数 ÷ 文章总数', detail: '关键词匹配未通过的文章数及其在全部文章中的占比' },
  '重复': { formula: '重复数 ÷ 文章总数', detail: '与历史文章重复的文章数及其在全部文章中的占比' },
  '软文': { formula: '软文数 ÷ 文章总数', detail: 'AI 判定为广告/软文的文章数及其在全部文章中的占比' },
  '状态': { formula: '数据源当前运行状态', detail: '正常 / 熔断（连续失败）/ 警告 / 已禁用' },
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatNumber(value: number): string {
  return value.toLocaleString()
}

function statusLabel(status: string, enabled: boolean): string {
  if (!enabled) return '已禁用'
  if (status === 'breaker') return '熔断'
  if (status === 'warning') return '警告'
  if (status === 'normal') return '正常'
  return '未抓取'
}

type CrawlTriggerFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['trigger']
type CrawlStatusFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['status']
type CrawlTypeFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['type']

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-red-600'
}

function rateColor(rate: number, inverse = false): string {
  const positive = inverse ? rate < 0.2 : rate >= 0.6
  const warning = inverse ? rate < 0.4 : rate >= 0.3
  if (positive) return 'text-emerald-600'
  if (warning) return 'text-amber-600'
  return 'text-red-600'
}





export default function DashboardTab({ active = true }: { active?: boolean }) {
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null)
  // 默认展示一周：保证日趋势图有可读的时间密度；“全部”仍保留为显式筛选，
  // 避免概览首次打开就把全量 Article/DiscardedItem/FetchLog 载入内存并参与轮询。
  const [range, setRange] = useState<DashboardAnalyticsRange>('7d')
  const [sourceSort, setSourceSort] = useState<SourceSort>('analyzed')
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)
  const [crawlPage, setCrawlPage] = useState(1)
  const [crawlTrigger, setCrawlTrigger] = useState<CrawlTriggerFilter>('all')
  const [crawlStatus, setCrawlStatus] = useState<CrawlStatusFilter>('all')
  const [crawlType, setCrawlType] = useState<CrawlTypeFilter>('all')
  const [crawlSourceId, setCrawlSourceId] = useState('all')
  const [tooltipInfo, setTooltipInfo] = useState<{ field: string; x: number; y: number } | null>(null)
  const [suggestions, setSuggestions] = useState<FeedbackSuggestion[]>([])
  const intervalRef = useRef<number | null>(null)
  const analyticsRequestRef = useRef<AbortController | null>(null)
  const analyticsRequestVersionRef = useRef(0)
  const feedbackGenerationAttemptedRef = useRef(false)

  const fetchData = useCallback(async () => {
    analyticsRequestRef.current?.abort()
    const controller = new AbortController()
    analyticsRequestRef.current = controller
    const requestVersion = ++analyticsRequestVersionRef.current
    try {
      const shouldGenerateFeedback = !feedbackGenerationAttemptedRef.current
      feedbackGenerationAttemptedRef.current = true
      const feedbackRequest = shouldGenerateFeedback
        ? generateFeedbackSuggestions(controller.signal).catch(() => fetchFeedbackSuggestions(controller.signal))
        : fetchFeedbackSuggestions(controller.signal)
      const [analyticsJson, nextSuggestions] = await Promise.all([
        fetchDashboardAnalytics(range, undefined, controller.signal, {
          page: crawlPage,
          trigger: crawlTrigger === 'all' ? undefined : crawlTrigger,
          status: crawlStatus === 'all' ? undefined : crawlStatus,
          type: crawlType === 'all' ? undefined : crawlType,
          sourceId: crawlSourceId === 'all' ? undefined : crawlSourceId,
        }),
        feedbackRequest.catch(() => []),
      ])
      if (controller.signal.aborted || requestVersion !== analyticsRequestVersionRef.current) return
      setAnalytics(analyticsJson)
      setSuggestions(nextSuggestions)
    } catch (error) {
      if (controller.signal.aborted || isRequestAborted(error)) return
      if (requestVersion !== analyticsRequestVersionRef.current) return
      toast.error('获取概览数据失败')
    } finally {
      if (analyticsRequestRef.current === controller) {
        analyticsRequestRef.current = null
        if (requestVersion === analyticsRequestVersionRef.current) setLoading(false)
      }
    }
  }, [crawlPage, crawlSourceId, crawlStatus, crawlTrigger, crawlType, range])

  useEffect(() => () => {
    analyticsRequestRef.current?.abort()
  }, [])

  const handleSuggestion = async (id: string, action: 'apply' | 'dismiss') => {
    try {
      await updateFeedbackSuggestion(id, action)
      setSuggestions((items) => items.filter((item) => item.id !== id))
      toast.success(action === 'apply' ? '建议已应用' : '建议已忽略')
    } catch {
      toast.error('处理建议失败')
    }
  }

  const handleRefresh = () => {
    setRefreshToken((value) => value + 1)
    void fetchData()
  }

  const openPopularArticle = useCallback((articleId: string) => {
    if (typeof window === 'undefined') return
    const url = new URL('/admin', window.location.origin)
    url.searchParams.set('articleId', articleId)
    window.location.assign(url.toString())
  }, [])

  useEffect(() => {
    if (!active) return
    const handle = setTimeout(fetchData, 0)
    return () => clearTimeout(handle)
  }, [active, fetchData])

  useEffect(() => {
    if (!active || !autoRefresh) return
    const tick = () => {
      if (document.visibilityState === 'visible') void fetchData()
    }
    intervalRef.current = window.setInterval(tick, 30_000)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchData()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [active, autoRefresh, fetchData])

  useEffect(() => {
    if (!tooltipInfo) return
    const handleClick = () => setTooltipInfo(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [tooltipInfo])

  const sortedSources = useMemo(() => {
    if (!analytics) return []
    return [...analytics.sources].sort((a, b) => {
      const difference = b[sourceSort] - a[sourceSort]
      return difference || a.name.localeCompare(b.name)
    })
  }, [analytics, sourceSort])

  if (loading) {
    return (
      <div className="space-y-1 pt-1">
        <div className="flex min-h-9 items-center justify-between gap-2 border bg-border">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-7 w-20" />
        </div>
        <Card className="py-0"><CardContent className="space-y-2 p-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-32 w-full" /></CardContent></Card>
      </div>
    )
  }

  if (!analytics) return null

  const summary = analytics.summary
  return (
    <div className="space-y-1 pt-0 [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:shadow-none">
      <div className="flex min-h-10 flex-wrap items-stretch border bg-border">
        <div className="flex items-center gap-1 bg-background px-1.5">
          <h2 className="text-sm font-semibold">概览</h2>
          <select
            id="overview-range"
            value={range}
            onChange={(event) => setRange(event.target.value as DashboardAnalyticsRange)}
            className="h-6 border bg-background px-1.5 text-[10px] outline-none focus:ring-1 focus:ring-ring"
          >
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className={`h-6 border px-1.5 text-[10px] transition-colors hover:bg-muted ${autoRefresh ? 'text-foreground' : 'text-muted-foreground'}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-pressed={autoRefresh}
          >
            自动更新 {autoRefresh ? '开' : '关'}
          </button>
          <Button size="sm" variant="ghost" className="h-6 gap-1 rounded-none px-1.5 text-[10px]" onClick={handleRefresh}>
            <RefreshCw className="h-3 w-3" />刷新
          </Button>
        </div>
        <div className="grid min-w-[300px] flex-1 grid-cols-3 gap-px">
          <div className="flex items-center justify-between gap-2 bg-background px-2"><span className="text-[10px] text-muted-foreground">公开浏览</span><strong className="text-sm tabular-nums">{formatNumber(summary.views)}</strong></div>
          <div className="flex items-center justify-between gap-2 bg-background px-2"><span className="text-[10px] text-muted-foreground">查看原文</span><strong className="text-sm tabular-nums">{formatNumber(summary.originalClicks)}</strong></div>
          <div className="flex items-center justify-between gap-2 bg-background px-2"><span className="text-[10px] text-muted-foreground">点击率</span><strong className="text-sm tabular-nums">{formatPercent(summary.clickRate)}</strong></div>
        </div>
      </div>

      <section className="space-y-1">

          <Card className="py-0">
            <CardContent className="p-2.5 sm:p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">数据源质量</h3>
                </div>
                <select
                  value={sourceSort}
                  onChange={(event) => setSourceSort(event.target.value as SourceSort)}
                  className="h-7 border bg-background px-2 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                  aria-label="数据源排序"
                >
                  <option value="found">按发现数</option>
                  <option value="totalArticles">按文章总数</option>
                  <option value="avgScore">按平均分</option>
                  <option value="ingested">按入库数</option>
                  <option value="processed">按处理数</option>
                  <option value="analyzed">按AI分析数</option>
                  <option value="pushed">按推送数</option>
                  <option value="unmatched">按未命中数</option>
                  <option value="duplicates">按重复数</option>
                  <option value="ads">按软文数</option>
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1060px] whitespace-nowrap border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b text-left text-[11px] text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          数据源
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '数据源', x: e.clientX, y: e.clientY }) }}
                            aria-label="数据源说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          发现
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '发现', x: e.clientX, y: e.clientY }) }}
                            aria-label="发现说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          文章总数
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '文章总数', x: e.clientX, y: e.clientY }) }}
                            aria-label="文章总数说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          平均分
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '平均分', x: e.clientX, y: e.clientY }) }}
                            aria-label="平均分说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          入库
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '入库', x: e.clientX, y: e.clientY }) }}
                            aria-label="入库说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          处理
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '处理', x: e.clientX, y: e.clientY }) }}
                            aria-label="处理说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          AI分析
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: 'AI分析', x: e.clientX, y: e.clientY }) }}
                            aria-label="AI分析说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          推送
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '推送', x: e.clientX, y: e.clientY }) }}
                            aria-label="推送说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          未命中
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '未命中', x: e.clientX, y: e.clientY }) }}
                            aria-label="未命中说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          重复
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '重复', x: e.clientX, y: e.clientY }) }}
                            aria-label="重复说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          软文
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '软文', x: e.clientX, y: e.clientY }) }}
                            aria-label="软文说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <span className="inline-flex items-center gap-1">
                          状态
                          <button
                            className="text-muted-foreground/50 hover:text-muted-foreground cursor-help"
                            onClick={(e) => { e.stopPropagation(); setTooltipInfo({ field: '状态', x: e.clientX, y: e.clientY }) }}
                            aria-label="状态说明"
                          >
                            <HelpCircle className="h-3 w-3" />
                          </button>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSources.map((source) => (
                      <tr
                        key={source.id}
                        className="border-b last:border-0 hover:bg-muted/50"
                      >
                        <td className="max-w-[220px] px-2 py-1.5">
                          <div className="truncate font-medium" title={source.name}>{source.name}</div>
                        </td>
                        <td className="px-2 py-1.5 tabular-nums">{formatNumber(source.found)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{formatNumber(source.totalArticles)}</td>
                        <td className={`px-2 py-1.5 font-medium tabular-nums ${scoreColor(source.avgScore)}`}>{source.analyzed ? source.avgScore : '—'}</td>
                        <td className="px-2 py-1.5 tabular-nums">{formatNumber(source.ingested)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{formatNumber(source.processed)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{formatNumber(source.analyzed)}</td>
                        <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(source.pushed)}</span><span className={`ml-1 text-[10px] ${rateColor(source.pushRate)}`}>{formatPercent(source.pushRate)}</span></td>
                        <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(source.unmatched)}</span><span className={`ml-1 text-[10px] ${rateColor(source.unmatchedRate, true)}`}>{formatPercent(source.unmatchedRate)}</span></td>
                        <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(source.duplicates)}</span><span className={`ml-1 text-[10px] ${rateColor(source.duplicateRate, true)}`}>{formatPercent(source.duplicateRate)}</span></td>
                        <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(source.ads)}</span><span className={`ml-1 text-[10px] ${rateColor(source.adRate, true)}`}>{formatPercent(source.adRate)}</span></td>
                        <td className="px-2 py-1.5"><Badge variant={source.status === 'breaker' ? 'destructive' : 'secondary'} className="px-1.5 py-0 text-[10px]">{statusLabel(source.status, source.enabled)}</Badge></td>
                      </tr>
                    ))}
                    <tr className="border-t-2 bg-muted/30 font-medium">
                      <td className="px-2 py-1.5">
                        <span>汇总</span><span className="ml-2 text-[10px] font-normal text-muted-foreground">全部 {formatNumber(summary.sourceCount)} 个数据源</span>
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">{formatNumber(summary.found)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatNumber(summary.totalArticles)}</td>
                      <td className={`px-2 py-1.5 tabular-nums ${scoreColor(summary.avgScore)}`}>{summary.analyzed ? summary.avgScore : '—'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatNumber(summary.ingested)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatNumber(summary.processed)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatNumber(summary.analyzed)}</td>
                      <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(summary.pushed)}</span><span className={`ml-1 text-[10px] ${rateColor(summary.pushRate)}`}>{formatPercent(summary.pushRate)}</span></td>
                      <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(summary.unmatched)}</span><span className={`ml-1 text-[10px] ${rateColor(summary.unmatchedRate, true)}`}>{formatPercent(summary.unmatchedRate)}</span></td>
                      <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(summary.duplicates)}</span><span className={`ml-1 text-[10px] ${rateColor(summary.duplicateRate, true)}`}>{formatPercent(summary.duplicateRate)}</span></td>
                      <td className="px-2 py-1.5 tabular-nums"><span className="font-medium">{formatNumber(summary.ads)}</span><span className={`ml-1 text-[10px] ${rateColor(summary.adRate, true)}`}>{formatPercent(summary.adRate)}</span></td>
                      <td className="px-2 py-1.5 text-muted-foreground">—</td>
                    </tr>
                  </tbody>
                </table>
                {sortedSources.length === 0 && <div className="py-8 text-center text-xs text-muted-foreground">暂无数据源</div>}
              </div>
            </CardContent>
          </Card>

          <div className="grid min-w-0 items-start gap-1 xl:grid-cols-2">
            <CrawlTimeCard
              records={analytics.crawlRecords}
              pagination={analytics.crawlPagination}
              sources={analytics.sources}
              filters={{ trigger: crawlTrigger, status: crawlStatus, type: crawlType, sourceId: crawlSourceId }}
              onTriggerChange={(value) => { setCrawlTrigger(value); setCrawlPage(1) }}
              onStatusChange={(value) => { setCrawlStatus(value); setCrawlPage(1) }}
              onTypeChange={(value) => { setCrawlType(value); setCrawlPage(1) }}
              onSourceChange={(value) => { setCrawlSourceId(value); setCrawlPage(1) }}
              onPageChange={setCrawlPage}
            />

            <PushLogPanel active={active} refreshToken={refreshToken} startAt={analytics.startAt} endAt={analytics.endAt} />

            <TopViewedArticlesCard
              articles={analytics.topViewedArticles}
              onArticleClick={openPopularArticle}
            />

            <div className="grid min-w-0 max-w-full gap-1">
              <DailyNewArticlesCard articles={analytics.dailyNewArticles} />
              <DailyPublicArticlesCard articles={analytics.dailyNewArticles} />
              <DailyPushedArticlesCard articles={analytics.dailyNewArticles} />
            </div>

          </div>

          {suggestions.length > 0 && <Card><CardContent className="p-2"><div className="mb-1 flex items-center gap-2"><span className="text-sm font-medium">人工反馈建议</span><Badge variant="secondary" className="rounded-none text-[10px]">需确认</Badge></div><div className="divide-y border-t">{suggestions.slice(0, 5).map((item) => <div key={item.id} className="py-1.5"><div className="flex items-center gap-2"><span className="text-xs font-medium">{item.title}</span><span className="ml-auto text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">{item.detail}</p><div className="mt-1 flex gap-1"><Button size="sm" className="h-6 rounded-none px-2 text-[11px]" onClick={() => void handleSuggestion(item.id, 'apply')}>确认应用</Button><Button size="sm" variant="ghost" className="h-6 rounded-none px-2 text-[11px]" onClick={() => void handleSuggestion(item.id, 'dismiss')}>忽略</Button></div></div>)}</div></CardContent></Card>}

          {tooltipInfo && SOURCE_FIELD_HELP[tooltipInfo.field] && (
            <div
              className="fixed z-50 w-64 rounded-md border bg-popover p-2.5 text-[10px] text-popover-foreground shadow-lg"
              style={{ left: tooltipInfo.x + 12, top: tooltipInfo.y + 8 }}
            >
              <div className="font-medium mb-1">{tooltipInfo.field}</div>
              <div className="text-muted-foreground">计算：{SOURCE_FIELD_HELP[tooltipInfo.field].formula}</div>
              <div className="text-muted-foreground mt-1">{SOURCE_FIELD_HELP[tooltipInfo.field].detail}</div>
            </div>
          )}
      </section>

    </div>
  )
}
