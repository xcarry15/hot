'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  fetchDashboardAnalytics,
  fetchFeedbackSuggestions,
  updateFeedbackSuggestion,
  type FeedbackSuggestion,
  type DashboardAnalytics,
  type DashboardAnalyticsRange,
} from '@/features/dashboard-api.client'
import { Skeleton } from '@/components/ui/skeleton'
import PushLogPanel from '@/components/push-log-panel'
import {
  AlertTriangle,
  Bot,
  ChevronLeft,
  ChevronRight,
  Fingerprint,
  HelpCircle,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'

type SourceSort = 'found' | 'totalArticles' | 'avgScore' | 'ingested' | 'processed' | 'analyzed' | 'pushed' | 'unmatched' | 'duplicates' | 'ads'

const RANGE_OPTIONS: Array<{ value: DashboardAnalyticsRange; label: string }> = [
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

function formatRecordTime(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

function crawlTriggerLabel(trigger: DashboardAnalytics['crawlRecords'][number]['trigger']): string {
  if (trigger === 'auto') return '自动'
  if (trigger === 'manual') return '手动'
  return '历史未标记'
}

function crawlStatusLabel(status: DashboardAnalytics['crawlRecords'][number]['status']): string {
  if (status === 'succeeded' || status === 'completed') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已停止'
  if (status === 'cancel_requested') return '停止中'
  if (status === 'running') return '运行中'
  return '等待中'
}

type CrawlTriggerFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['trigger']
type CrawlStatusFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['status']
type CrawlTypeFilter = 'all' | DashboardAnalytics['crawlRecords'][number]['type']

interface CrawlTimeCardProps {
  records: DashboardAnalytics['crawlRecords']
  pagination: DashboardAnalytics['crawlPagination']
  sources: DashboardAnalytics['sources']
  filters: {
    trigger: CrawlTriggerFilter
    status: CrawlStatusFilter
    type: CrawlTypeFilter
    sourceId: string
  }
  onTriggerChange: (value: CrawlTriggerFilter) => void
  onStatusChange: (value: CrawlStatusFilter) => void
  onTypeChange: (value: CrawlTypeFilter) => void
  onSourceChange: (value: string) => void
  onPageChange: (page: number) => void
}

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

function TrendBody({ points }: { points: DashboardAnalytics['trend'] }) {
  const maxTotal = Math.max(1, ...points.map((point) => point.stackNew + point.stackAds + point.stackPushed + point.stackDuplicates))
  const series = [
    { key: 'stackNew', label: '普通新增（未推送）', color: 'bg-blue-500' },
    { key: 'stackAds', label: '软文（未推送）', color: 'bg-amber-500' },
    { key: 'stackPushed', label: '已推送', color: 'bg-emerald-500' },
    { key: 'stackDuplicates', label: '重复项', color: 'bg-slate-400' },
  ] as const

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {series.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1"><i className={`h-2 w-2 rounded-sm ${item.color}`} />{item.label}</span>
        ))}
      </div>

      <div className="flex h-32 items-end gap-1 border-b border-l px-2 pb-1 sm:gap-2">
        {points.map((point) => (
          <div key={point.date} className="group relative flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden min-w-[118px] -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-[10px] text-popover-foreground shadow-md group-hover:block group-focus-within:block" role="tooltip">
              <div className="mb-1 font-medium">{point.label}</div>
              <div className="flex justify-between gap-3"><span>AI完成</span><span className="tabular-nums">{point.newArticles}</span></div>
              <div className="flex justify-between gap-3"><span>重复项</span><span className="tabular-nums">{point.duplicates}</span></div>
              <div className="flex justify-between gap-3"><span>软文</span><span className="tabular-nums">{point.ads}</span></div>
              <div className="flex justify-between gap-3"><span>已推送</span><span className="tabular-nums">{point.pushed}</span></div>
            </div>
            <div
              className="flex h-24 w-full max-w-12 flex-col-reverse justify-start overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
              aria-label={`${point.label}：AI完成 ${point.newArticles}，重复项 ${point.duplicates}，软文 ${point.ads}，已推送 ${point.pushed}`}
            >
              {series.map((item) => {
                const value = point[item.key]
                return <div key={item.key} className={`${item.color} w-full`} style={{ height: value ? `${value / maxTotal * 100}%` : '0%' }} />
              })}
            </div>
            <span className="max-w-full truncate text-[10px] text-muted-foreground">{point.label}</span>
          </div>
        ))}
      </div>

    </div>
  )
}

function TrendCard({
  title,
  points,
}: {
  title: string
  points: DashboardAnalytics['trend']
}) {
  return (
    <Card className="rounded-none py-0 shadow-none">
      <CardContent className="p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="text-[10px] text-muted-foreground">悬停查看各类处理结果</p>
          </div>
          {points.length > 1 && <span className="text-[10px] text-muted-foreground">{points.length} 个时间点</span>}
        </div>
        {points.length > 0 ? <TrendBody points={points} /> : <div className="py-8 text-center text-xs text-muted-foreground">暂无趋势数据</div>}
      </CardContent>
    </Card>
  )
}

function CrawlTimeCard({
  records,
  pagination,
  sources,
  filters,
  onTriggerChange,
  onStatusChange,
  onTypeChange,
  onSourceChange,
  onPageChange,
}: CrawlTimeCardProps) {
  return (
    <Card className="rounded-none py-0 shadow-none">
      <CardContent className="p-2.5">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <div className="mr-2 shrink-0">
            <h3 className="text-sm font-medium">任务中心</h3>
            <p className="text-[10px] text-muted-foreground">共 {pagination.total} 条 · 自动任务与手动任务</p>
          </div>
          <Select value={filters.trigger} onValueChange={(value) => onTriggerChange(value as CrawlTriggerFilter)}>
            <SelectTrigger className="h-7 w-[92px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="触发方式" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部方式</SelectItem>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="manual">手动</SelectItem>
              <SelectItem value="unknown">历史未标记</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.status} onValueChange={(value) => onStatusChange(value as CrawlStatusFilter)}>
            <SelectTrigger className="h-7 w-[88px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="结果" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部结果</SelectItem>
              <SelectItem value="succeeded">完成</SelectItem>
              <SelectItem value="completed">历史完成</SelectItem>
              <SelectItem value="running">运行中</SelectItem>
              <SelectItem value="cancel_requested">停止中</SelectItem>
              <SelectItem value="cancelled">已停止</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="queued">等待中</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.type} onValueChange={(value) => onTypeChange(value as CrawlTypeFilter)}>
            <SelectTrigger className="h-7 w-[88px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="任务类型" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部任务</SelectItem>
              <SelectItem value="full">全流程</SelectItem>
              <SelectItem value="collect">采集</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.sourceId} onValueChange={onSourceChange}>
            <SelectTrigger className="h-7 w-[126px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="数据源" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部数据源</SelectItem>
              {sources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-blue-500" />自动</span>
            <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-violet-500" />手动</span>
            {pagination.totalPages > 1 && <span>第 {pagination.page}/{pagination.totalPages} 页</span>}
          </div>
        </div>

        {records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] whitespace-nowrap border-collapse text-[11px]">
              <thead>
                <tr className="border-b text-left text-[11px] text-muted-foreground">
                  <th className="px-1.5 py-1 font-medium">开始时间</th>
                  <th className="px-1.5 py-1 font-medium">触发方式</th>
                  <th className="px-1.5 py-1 font-medium">任务 / 范围</th>
                  <th className="px-1.5 py-1 font-medium">结果</th>
                  <th className="px-1.5 py-1 font-medium">耗时</th>
                  <th className="px-1.5 py-1 font-medium">发现</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b last:border-0" title={record.error ?? undefined}>
                    <td className="px-1.5 py-1 tabular-nums">{formatRecordTime(record.startedAt)}</td>
                    <td className="px-1.5 py-1">
                      <Badge variant={record.trigger === 'auto' ? 'secondary' : 'outline'} className={`px-1.5 py-0 text-[10px] ${record.trigger === 'manual' ? 'border-violet-200 text-violet-700 dark:border-violet-800 dark:text-violet-300' : ''}`}>
                        {crawlTriggerLabel(record.trigger)}
                      </Badge>
                    </td>
                    <td className="max-w-[260px] px-1.5 py-1">
                      <div className="max-w-[260px] truncate font-medium" title={record.sourceLabel}>{record.type === 'full' ? '全流程' : '采集'} · <span className="font-normal text-muted-foreground">{record.sourceLabel}</span></div>
                    </td>
                    <td className="px-1.5 py-1">
                      <Badge variant={record.status === 'failed' ? 'destructive' : record.status === 'succeeded' || record.status === 'completed' ? 'secondary' : 'outline'} className="px-1.5 py-0 text-[10px]">
                        {crawlStatusLabel(record.status)}
                      </Badge>
                    </td>
                    <td className="px-1.5 py-1 text-muted-foreground tabular-nums">{formatDuration(record.durationMs)}</td>
                    <td className="px-1.5 py-1 tabular-nums">{record.itemsFound == null ? '—' : formatNumber(record.itemsFound)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-5 text-center text-xs text-muted-foreground">暂无符合条件的任务记录</div>
        )}

        {pagination.totalPages > 1 && (
          <div className="mt-1.5 flex items-center justify-between border-t pt-1.5">
            <span className="text-[11px] text-muted-foreground">每页 {pagination.pageSize} 条</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} aria-label="上一页"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)} aria-label="下一页"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface SourceAttention {
  sourceId: string
  sourceName: string
  sourceStatus: string
  sourceEnabled: boolean
  alerts: Array<{
    level: 'critical' | 'warning'
    icon: LucideIcon
    label: string
    value: string
    detail: string
    threshold: string
  }>
  summary: {
    criticalCount: number
    warningCount: number
  }
}

function buildSourceAttention(analytics: DashboardAnalytics): SourceAttention[] {
  const avgScores = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.avgScore)
  const avgDuplicateRate = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.duplicateRate)
  const avgAdRate = analytics.sources.filter(s => s.analyzed >= 3).map(s => s.adRate)
  const avgPushRate = analytics.sources.filter(s => s.pushed > 0).map(s => s.pushRate)

  const avgScoreAvg = avgScores.length > 0 ? avgScores.reduce((a, b) => a + b, 0) / avgScores.length : 0
  const avgDuplicateRateAvg = avgDuplicateRate.length > 0 ? avgDuplicateRate.reduce((a, b) => a + b, 0) / avgDuplicateRate.length : 0
  const avgAdRateAvg = avgAdRate.length > 0 ? avgAdRate.reduce((a, b) => a + b, 0) / avgAdRate.length : 0
  const avgPushRateAvg = avgPushRate.length > 0 ? avgPushRate.reduce((a, b) => a + b, 0) / avgPushRate.length : 0

  return analytics.sources.flatMap((source) => {
    const alerts: SourceAttention['alerts'] = []

    if (source.fetchFailures > 0) {
      alerts.push({
        level: 'critical',
        icon: AlertTriangle,
        label: '抓取失败',
        value: `${source.fetchFailures} 次`,
        detail: `最近一次抓取失败，影响新内容发现`,
        threshold: `> 0 次`,
      })
    }

    if (source.analyzed >= 3) {
      if (source.avgScore < 60) {
        alerts.push({
          level: 'critical',
          icon: Bot,
          label: '内容评分低',
          value: `${source.avgScore} 分`,
          detail: `低于均值 ${avgScoreAvg.toFixed(1)} 分，可读性差或价值不足`,
          threshold: `≥ 60 分合格`,
        })
      } else if (source.avgScore < avgScoreAvg * 0.8) {
        alerts.push({
          level: 'warning',
          icon: Bot,
          label: '内容评分偏低',
          value: `${source.avgScore} 分`,
          detail: `低于同类均值 ${avgScoreAvg.toFixed(1)} 分`,
          threshold: `同类均值 ${avgScoreAvg.toFixed(1)} 分`,
        })
      }

      if (source.duplicateRate >= 0.3) {
        alerts.push({
          level: 'critical',
          icon: Fingerprint,
          label: '重复率过高',
          value: formatPercent(source.duplicateRate),
          detail: `高于同类均值 ${formatPercent(avgDuplicateRateAvg)}，大量内容与历史重复`,
          threshold: `≥ 30% 为严重`,
        })
      } else if (source.duplicateRate >= 0.15) {
        alerts.push({
          level: 'warning',
          icon: Fingerprint,
          label: '重复率偏高',
          value: formatPercent(source.duplicateRate),
          detail: `高于同类均值 ${formatPercent(avgDuplicateRateAvg)}，注意监测趋势`,
          threshold: `同类均值 ${formatPercent(avgDuplicateRateAvg)}`,
        })
      }

      if (source.adRate >= 0.3) {
        alerts.push({
          level: 'critical',
          icon: ShieldAlert,
          label: '软文率过高',
          value: formatPercent(source.adRate),
          detail: `高于同类均值 ${formatPercent(avgAdRateAvg)}，大量内容为广告/软文`,
          threshold: `≥ 30% 为严重`,
        })
      } else if (source.adRate >= 0.15) {
        alerts.push({
          level: 'warning',
          icon: ShieldAlert,
          label: '软文率偏高',
          value: formatPercent(source.adRate),
          detail: `高于同类均值 ${formatPercent(avgAdRateAvg)}，注意监测趋势`,
          threshold: `同类均值 ${formatPercent(avgAdRateAvg)}`,
        })
      }
    }

    if (source.newArticles > 0 && source.pushed === 0) {
      alerts.push({
        level: 'warning',
        icon: Send,
        label: '有新增未推送',
        value: `${source.newArticles} 篇`,
        detail: `AI完成文章但全部未推送，可能关键词配置过严或推送渠道异常`,
        threshold: `推送率 > 0%`,
      })
    }

    if (source.pushed > 0 && avgPushRateAvg > 0 && source.pushRate < avgPushRateAvg * 0.5) {
      alerts.push({
        level: 'warning',
        icon: Send,
        label: '推送率偏低',
        value: formatPercent(source.pushRate),
        detail: `低于同类均值 ${formatPercent(avgPushRateAvg)}，内容质量或关键词匹配效率低`,
        threshold: `同类均值 ${formatPercent(avgPushRateAvg)}`,
      })
    }

    if (alerts.length === 0) return []

    const criticalCount = alerts.filter(a => a.level === 'critical').length
    const warningCount = alerts.filter(a => a.level === 'warning').length

    return [{
      sourceId: source.id,
      sourceName: source.name,
      sourceStatus: source.status,
      sourceEnabled: source.enabled,
      alerts,
      summary: { criticalCount, warningCount },
    }]
  })
}

function statusConfig(status: string, enabled: boolean) {
  if (!enabled) return { label: '已禁用', variant: 'secondary' as const }
  if (status === 'breaker') return { label: '熔断', variant: 'destructive' as const }
  if (status === 'warning') return { label: '警告', variant: 'outline' as const }
  if (status === 'normal') return { label: '正常', variant: 'secondary' as const }
  return { label: '未抓取', variant: 'secondary' as const }
}

export default function DashboardTab({ active = true }: { active?: boolean }) {
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null)
  const [range, setRange] = useState<DashboardAnalyticsRange>('today')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [sourceDetail, setSourceDetail] = useState<DashboardAnalytics | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
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

  const fetchData = useCallback(async () => {
    try {
      const analyticsJson = await fetchDashboardAnalytics(range, undefined, undefined, {
        page: crawlPage,
        trigger: crawlTrigger === 'all' ? undefined : crawlTrigger,
        status: crawlStatus === 'all' ? undefined : crawlStatus,
        type: crawlType === 'all' ? undefined : crawlType,
        sourceId: crawlSourceId === 'all' ? undefined : crawlSourceId,
      })
      setAnalytics(analyticsJson)
      fetchFeedbackSuggestions().then(setSuggestions).catch(() => undefined)
    } catch {
      toast.error('获取概览数据失败')
    } finally {
      setLoading(false)
    }
  }, [crawlPage, crawlSourceId, crawlStatus, crawlTrigger, crawlType, range])

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

  useEffect(() => {
    if (!active || !selectedSourceId) {
      setSourceDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    fetchDashboardAnalytics(range, selectedSourceId)
      .then((result) => {
        if (!cancelled) setSourceDetail(result)
      })
      .catch(() => {
        if (!cancelled) toast.error('获取数据源详情失败')
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, range, selectedSourceId])

  const sortedSources = useMemo(() => {
    if (!analytics) return []
    return [...analytics.sources].sort((a, b) => {
      const difference = b[sourceSort] - a[sourceSort]
      return difference || a.name.localeCompare(b.name)
    })
  }, [analytics, sourceSort])

  const attention = analytics ? buildSourceAttention(analytics) : []

  if (loading) {
    return (
      <div className="space-y-1.5 pt-2">
        <div className="flex items-center justify-between gap-2 border-b pb-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-7 w-20" />
        </div>
        <Card className="py-0"><CardContent className="space-y-2.5 p-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-36 w-full" /></CardContent></Card>
      </div>
    )
  }

  if (!analytics) return null

  const summary = analytics.summary
  return (
    <div className="space-y-1 pt-1 [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:shadow-none">
      <div className="flex min-h-12 flex-wrap items-stretch border bg-border">
        <div className="flex items-center gap-1.5 bg-background px-2">
          <h2 className="text-sm font-semibold">概览</h2>
          <select
            id="overview-range"
            value={range}
            onChange={(event) => setRange(event.target.value as DashboardAnalyticsRange)}
            className="h-7 border bg-background px-2 text-[11px] outline-none focus:ring-1 focus:ring-ring"
          >
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className={`h-7 border px-2 text-[11px] transition-colors hover:bg-muted ${autoRefresh ? 'text-foreground' : 'text-muted-foreground'}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-pressed={autoRefresh}
          >
            自动更新 {autoRefresh ? '开' : '关'}
          </button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 rounded-none px-2 text-[11px]" onClick={handleRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />刷新
          </Button>
        </div>
        <div className="grid min-w-[420px] flex-1 grid-cols-2 gap-px sm:grid-cols-4">
          <div className="flex items-center justify-between gap-2 bg-background px-2.5"><span className="text-[10px] text-muted-foreground">公开浏览</span><strong className="text-base tabular-nums">{formatNumber(summary.views)}</strong></div>
          <div className="flex items-center justify-between gap-2 bg-background px-2.5"><span className="text-[10px] text-muted-foreground">查看原文</span><strong className="text-base tabular-nums">{formatNumber(summary.originalClicks)}</strong></div>
          <div className="flex items-center justify-between gap-2 bg-background px-2.5"><span className="text-[10px] text-muted-foreground">点击率</span><strong className="text-base tabular-nums">{formatPercent(summary.clickRate)}</strong></div>
          <div className="flex items-center justify-between gap-2 bg-background px-2.5"><span className="text-[10px] text-muted-foreground">待归类</span><strong className="text-base tabular-nums">{formatNumber(analytics.inbox.pending)}</strong></div>
        </div>
      </div>

      <section className="space-y-1">

          <Card className="py-0">
            <CardContent className="p-2.5 sm:p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">数据源质量</h3>
                  <p className="text-[10px] text-muted-foreground">点击行查看详情，点击列标题查看说明</p>
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
                        className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${selectedSourceId === source.id ? 'bg-muted/60' : ''}`}
                        onClick={() => setSelectedSourceId((current) => current === source.id ? null : source.id)}
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

          <PushLogPanel active={active} refreshToken={refreshToken} />

          <TrendCard title={`${RANGE_OPTIONS.find((option) => option.value === range)?.label ?? ''}文章处理结果趋势`} points={analytics.trend} />

          {suggestions.length > 0 && <Card><CardContent className="p-2.5"><div className="mb-1.5 flex items-center gap-2"><span className="text-sm font-medium">人工反馈建议</span><Badge variant="secondary" className="rounded-none text-[10px]">需确认</Badge></div><div className="divide-y border-t">{suggestions.slice(0, 5).map((item) => <div key={item.id} className="py-2"><div className="flex items-center gap-2"><span className="text-xs font-medium">{item.title}</span><span className="ml-auto text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">{item.detail}</p><div className="mt-1.5 flex gap-1"><Button size="sm" className="h-6 rounded-none px-2 text-[11px]" onClick={() => void handleSuggestion(item.id, 'apply')}>确认应用</Button><Button size="sm" variant="ghost" className="h-6 rounded-none px-2 text-[11px]" onClick={() => void handleSuggestion(item.id, 'dismiss')}>忽略</Button></div></div>)}</div></CardContent></Card>}

          {attention.length > 0 && (
            <Card className="border-amber-200 dark:border-amber-900/50">
              <CardContent className="p-3">
                <div className="mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                  <span className="text-sm font-medium">需要关注</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{attention.length} 个数据源</span>
                </div>
                <div className="divide-y border-t">
                  {attention.map((item) => (
                    <div key={item.sourceId} className="py-2">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">{item.sourceName}</span>
                        <Badge variant={statusConfig(item.sourceStatus, item.sourceEnabled).variant} className="px-1.5 py-0 text-[10px]">
                          {statusConfig(item.sourceStatus, item.sourceEnabled).label}
                        </Badge>
                        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="text-red-600 font-medium">{item.summary.criticalCount} 严重</span>
                          <span className="text-amber-600 font-medium">{item.summary.warningCount} 警告</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {item.alerts.map((alert, idx) => (
                          <div key={idx} title={alert.detail} className={`flex items-center gap-2 border-l-2 px-2 py-1 text-[11px] ${alert.level === 'critical' ? 'border-red-500 text-red-700 dark:text-red-300' : 'border-amber-500 text-amber-700 dark:text-amber-300'}`}>
                            <alert.icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span className="font-medium">{alert.label}</span>
                            <span className="font-medium">{alert.value}</span>
                            <span className="ml-auto shrink-0 text-muted-foreground">阈值：{alert.threshold}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {selectedSourceId && (
            detailLoading ? (
              <Card className="py-0"><CardContent className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载数据源详情</CardContent></Card>
            ) : sourceDetail?.sources[0] ? (
              <Card className="py-0">
                <CardContent className="p-3 sm:p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">{sourceDetail.sources[0].name} · 周期详情</h3>
                                                <p className="text-[10px] text-muted-foreground">可结合任务中心查看具体失败文章和过滤原因</p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelectedSourceId(null)}>收起</Button>
                  </div>
                  <TrendBody points={sourceDetail.trend} />
                </CardContent>
              </Card>
            ) : null
          )}

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
