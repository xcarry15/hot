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

export function TrendBody({ points }: { points: DashboardAnalytics['trend'] }) {
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

export function TrendCard({
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

