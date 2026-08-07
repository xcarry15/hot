"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DashboardAnalytics } from "@/features/dashboard-api.client"
import { ChevronLeft, ChevronRight } from "lucide-react"

type CrawlTriggerFilter = "all" | DashboardAnalytics["crawlRecords"][number]["trigger"]
type CrawlStatusFilter = "all" | DashboardAnalytics["crawlRecords"][number]["status"]
type CrawlTypeFilter = "all" | DashboardAnalytics["crawlRecords"][number]["type"]

interface CrawlTimeCardProps {
  records: DashboardAnalytics["crawlRecords"]
  pagination: DashboardAnalytics["crawlPagination"]
  sources: DashboardAnalytics["sources"]
  filters: { trigger: CrawlTriggerFilter; status: CrawlStatusFilter; type: CrawlTypeFilter; sourceId: string }
  onTriggerChange: (value: CrawlTriggerFilter) => void
  onStatusChange: (value: CrawlStatusFilter) => void
  onTypeChange: (value: CrawlTypeFilter) => void
  onSourceChange: (value: string) => void
  onPageChange: (page: number) => void
}

function formatNumber(value: number): string { return value.toLocaleString() }
function getChartAxisMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}
function getChartAxisTicks(axisMax: number, plotBottom: number, plotHeight: number): Array<{ y: number; value: number }> {
  const tickCount = Math.min(5, axisMax + 1)
  return Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1)
    return {
      y: plotBottom - ratio * plotHeight,
      value: Math.round(axisMax * ratio),
    }
  })
}
function formatPublishedAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function formatRecordTime(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}
function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}
function crawlTriggerLabel(trigger: DashboardAnalytics["crawlRecords"][number]["trigger"]): string {
  if (trigger === "auto") return "自动"
  if (trigger === "manual") return "手动"
  return "历史未标记"
}
function crawlStatusLabel(status: DashboardAnalytics["crawlRecords"][number]["status"]): string {
  if (status === "succeeded" || status === "completed") return "完成"
  if (status === "failed") return "失败"
  if (status === "cancelled") return "已停止"
  if (status === "cancel_requested") return "停止中"
  if (status === "running") return "运行中"
  return "等待中"
}

export function TopViewedArticlesCard({
  articles,
  onArticleClick,
}: {
  articles: DashboardAnalytics['topViewedArticles']
  onArticleClick: (articleId: string) => void
}) {
  const maxViews = Math.max(1, ...articles.map((article) => article.viewCount))

  return (
    <Card className="rounded-none py-0 shadow-none">
      <CardContent className="p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium" title="点击文章打开工作台详情">公开浏览 Top 20</h3>
          <span className="text-[10px] text-muted-foreground">{articles.length}/20 篇</span>
        </div>
        {articles.length > 0 ? (
          <div className="max-h-[420px] overflow-auto pr-1">
            <div className="grid min-w-[360px] grid-cols-[1.5rem_minmax(0,1fr)_6.25rem_2.5rem_3.5rem] items-center gap-2 border-b px-1.5 py-1 text-[10px] text-muted-foreground">
              <span />
              <span>文章</span>
              <span>发布时间</span>
              <span className="text-right">评分</span>
              <span className="text-right">浏览</span>
            </div>
            {articles.map((article, index) => {
              const width = article.viewCount > 0 ? Math.max(2, article.viewCount / maxViews * 100) : 0
              return (
                <button
                  key={article.id}
                  type="button"
                  className="group relative grid min-h-7 w-full min-w-[360px] grid-cols-[1.5rem_minmax(0,1fr)_6.25rem_2.5rem_3.5rem] items-center gap-2 overflow-hidden border-b border-border/40 px-1.5 py-1 text-left text-[11px] hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onArticleClick(article.id)}
                  title={`${article.title} · ${article.sourceName} · 发布时间 ${formatPublishedAt(article.publishedAt)} · ${article.score} 分 · ${formatNumber(article.viewCount)} 次公开浏览`}
                >
                  <span className="z-10 w-6 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
                  <span
                    className="absolute inset-y-0 left-9 bg-primary/10 transition-[width] group-hover:bg-primary/15"
                    style={{ width: `${width}%` }}
                    aria-hidden="true"
                  />
                  <span className="relative z-10 min-w-0 flex-1 truncate">{article.title}</span>
                  <span className="relative z-10 truncate tabular-nums text-muted-foreground">{formatPublishedAt(article.publishedAt)}</span>
                  <span className="relative z-10 text-right tabular-nums text-muted-foreground">{article.score}</span>
                  <span className="relative z-10 text-right tabular-nums text-muted-foreground">{formatNumber(article.viewCount)}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">暂无公开文章浏览数据</div>
        )}
      </CardContent>
    </Card>
  )
}

export function DailyNewArticlesCard({
  articles,
}: {
  articles: DashboardAnalytics['dailyNewArticles']
}) {
  const total = articles.reduce((sum, item) => sum + item.count, 0)
  const chartAxisMax = getChartAxisMax(Math.max(0, ...articles.map((item) => item.count)))
  const labelStep = Math.max(1, Math.ceil(articles.length / 6))
  const chartHeight = 160
  const plotTop = 12
  const plotBottom = chartHeight - 26
  const plotHeight = plotBottom - plotTop
  const axisLeft = 34
  const axisRight = 12
  const slotWidth = Math.max(52, 500 / Math.max(1, articles.length))
  const plotWidth = Math.max(500, articles.length * slotWidth)
  const chartWidth = axisLeft + plotWidth + axisRight
  const getX = (index: number) => axisLeft + slotWidth * (index + 0.5)
  const getY = (value: number) => plotBottom - (value / chartAxisMax) * plotHeight
  const barWidth = Math.min(28, slotWidth * 0.42)
  const axisTicks = getChartAxisTicks(chartAxisMax, plotBottom, plotHeight)
  const points = articles.map((item, index) => `${getX(index)},${getY(item.count)}`).join(' ')

  return (
    <Card className="rounded-none py-0 shadow-none">
      <CardContent className="p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">每日新增</h3>
          <span className="text-[10px] text-muted-foreground">期间合计 {formatNumber(total)} 篇</span>
        </div>
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-sm bg-primary/75" />新增文章</span>
          <span className="text-muted-foreground/75">按入库时间统计 · 单位：篇</span>
        </div>
        {articles.length > 0 ? (
          <div className="mt-1 h-[180px] overflow-x-auto border-b border-l px-1 pb-1 pt-2">
            <svg
              className="block"
              width={chartWidth}
              height={chartHeight}
              role="img"
              aria-label="每日新增文章数量和趋势"
            >
              {axisTicks.map((tick, index) => (
                <g key={index}>
                  <line x1={axisLeft} x2={axisLeft + plotWidth} y1={tick.y} y2={tick.y} stroke="hsl(var(--border))" strokeDasharray="2 3" />
                  <text x={axisLeft - 6} y={tick.y + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" className="text-[10px]">{formatNumber(tick.value)}</text>
                </g>
              ))}
              <line x1={axisLeft} x2={axisLeft} y1={plotTop} y2={plotBottom} stroke="hsl(var(--border))" />
              <line x1={axisLeft} x2={axisLeft + plotWidth} y1={plotBottom} y2={plotBottom} stroke="hsl(var(--border))" />
              <polyline points={points} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

              {articles.map((item, index) => {
                const x = getX(index)
                const [, month, day] = item.date.split('-')
                const showLabel = articles.length <= 7 || index === 0 || index === articles.length - 1 || index % labelStep === 0
                const barHeight = (item.count / chartAxisMax) * plotHeight
                return (
                  <g key={item.date}>
                    <title>{`${item.date} · 新增文章 ${item.count}`}</title>
                    <rect x={x - barWidth / 2} y={plotBottom - barHeight} width={barWidth} height={barHeight} rx={3} fill="hsl(var(--primary))" opacity={0.3} />
                    {showLabel && item.count > 0 && <text x={x} y={Math.max(plotTop + 10, plotBottom - barHeight - 5)} textAnchor="middle" fill="hsl(var(--foreground))" className="text-[9px] tabular-nums">{formatNumber(item.count)}</text>}
                    <text x={x} y={chartHeight - 8} textAnchor="middle" fill="hsl(var(--muted-foreground))" className="text-[9px] tabular-nums">{showLabel ? `${Number(month)}/${Number(day)}` : ''}</text>
                  </g>
                )
              })}
            </svg>
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">暂无新增文章数据</div>
        )}
      </CardContent>
    </Card>
  )
}

type DailyMetric = 'publicCount' | 'pushedCount'

function DailyActivityCard({
  articles,
  metric,
  title,
  label,
  color,
  emptyText,
}: {
  articles: DashboardAnalytics['dailyNewArticles']
  metric: DailyMetric
  title: string
  label: string
  color: string
  emptyText: string
}) {
  const chartAxisMax = getChartAxisMax(Math.max(0, ...articles.map((item) => item[metric])))
  const labelStep = Math.max(1, Math.ceil(articles.length / 6))
  const chartHeight = 160
  const plotTop = 12
  const plotBottom = chartHeight - 26
  const plotHeight = plotBottom - plotTop
  const axisLeft = 34
  const axisRight = 12
  const slotWidth = Math.max(52, 500 / Math.max(1, articles.length))
  const plotWidth = Math.max(500, articles.length * slotWidth)
  const chartWidth = axisLeft + plotWidth + axisRight
  const getX = (index: number) => axisLeft + slotWidth * (index + 0.5)
  const barWidth = Math.min(28, slotWidth * 0.42)
  const axisTicks = getChartAxisTicks(chartAxisMax, plotBottom, plotHeight)

  return (
    <Card className="rounded-none py-0 shadow-none">
      <CardContent className="p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: color }} />{label}</span>
          <span className="text-muted-foreground/75">按动作发生日 · 单位：次</span>
        </div>
        {articles.length > 0 ? (
          <div className="mt-1 h-[180px] overflow-x-auto border-b border-l px-1 pb-1 pt-2">
            <svg
              className="block"
              width={chartWidth}
              height={chartHeight}
              role="img"
              aria-label={`${title}数量`}
            >
              {axisTicks.map((tick, index) => (
                <g key={index}>
                  <line x1={axisLeft} x2={axisLeft + plotWidth} y1={tick.y} y2={tick.y} stroke="hsl(var(--border))" strokeDasharray="2 3" />
                  <text x={axisLeft - 6} y={tick.y + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" className="text-[10px]">{formatNumber(tick.value)}</text>
                </g>
              ))}
              <line x1={axisLeft} x2={axisLeft} y1={plotTop} y2={plotBottom} stroke="hsl(var(--border))" />
              <line x1={axisLeft} x2={axisLeft + plotWidth} y1={plotBottom} y2={plotBottom} stroke="hsl(var(--border))" />

              {articles.map((item, index) => {
                const x = getX(index)
                const [, month, day] = item.date.split('-')
                const showLabel = articles.length <= 7 || index === 0 || index === articles.length - 1 || index % labelStep === 0
                const value = item[metric]
                const barHeight = (value / chartAxisMax) * plotHeight
                return (
                  <g key={item.date}>
                    <title>{`${item.date} · ${label} ${value}`}</title>
                    <rect x={x - barWidth / 2} y={plotBottom - barHeight} width={barWidth} height={barHeight} rx={3} fill={color} opacity={0.75} />
                    {showLabel && value > 0 && <text x={x} y={Math.max(plotTop + 10, plotBottom - barHeight - 5)} textAnchor="middle" fill="hsl(var(--foreground))" className="text-[9px] tabular-nums">{formatNumber(value)}</text>}
                    <text x={x} y={chartHeight - 8} textAnchor="middle" fill="hsl(var(--muted-foreground))" className="text-[9px] tabular-nums">{showLabel ? `${Number(month)}/${Number(day)}` : ''}</text>
                  </g>
                )
              })}
            </svg>
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">{emptyText}</div>
        )}
      </CardContent>
    </Card>
  )
}

export function DailyPublicArticlesCard({
  articles,
}: {
  articles: DashboardAnalytics['dailyNewArticles']
}) {
  return <DailyActivityCard articles={articles} metric="publicCount" title="每日公开" label="公开事件" color="hsl(160 84% 39%)" emptyText="暂无公开数据" />
}

export function DailyPushedArticlesCard({
  articles,
}: {
  articles: DashboardAnalytics['dailyNewArticles']
}) {
  return <DailyActivityCard articles={articles} metric="pushedCount" title="每日推送" label="推送事件" color="hsl(262 83% 58%)" emptyText="暂无推送数据" />
}

export function CrawlTimeCard({
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
    <Card className="h-[372px] max-h-[372px] overflow-hidden rounded-none py-0 shadow-none">
      <CardContent className="p-2">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <div className="mr-2 shrink-0">
            <h3 className="text-sm font-medium">抓取记录</h3>
            <p className="text-[10px] text-muted-foreground">共 {pagination.total} 条</p>
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
                  <th className="px-1.5 py-1 font-medium">新增</th>
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
                    <td className="px-1.5 py-1 tabular-nums">{record.newArticles == null ? '—' : formatNumber(record.newArticles)}</td>
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
            <span className="text-[11px] text-muted-foreground">第 {pagination.page}/{pagination.totalPages} 页</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} aria-label="上一页"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)} aria-label="下一页"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
