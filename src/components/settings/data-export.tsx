'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, FileSpreadsheet, Loader2, RefreshCcw, RotateCcw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchSources } from '@/features/sources-api.client'
import {
  cancelDataExportJob,
  createDataExportJob,
  deleteDataExportJob,
  downloadDataExportFile,
  listDataExportJobs,
  retryDataExportJob,
} from '@/features/data-export-api.client'
import {
  DEFAULT_EXPORT_FILTER,
  type ExportFilter,
  type ExportJobDto,
} from '@/contracts/data-export'

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '可下载',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
}

const SOURCE_STATUS_OPTIONS = [
  ['pending', '待抓取'],
  ['fetched', '已抓取'],
  ['failed', '抓取失败'],
] as const
const AI_STATUS_OPTIONS = [
  ['pending', '待分析'],
  ['done', '已完成'],
  ['skipped', '已跳过'],
  ['failed', '分析失败'],
] as const
const CLUSTER_STATUS_OPTIONS = [
  ['pending', '待聚类'],
  ['clustered', '已聚类'],
  ['failed', '聚类失败'],
  ['needs_review', '待复核'],
] as const
const PUBLIC_STATUS_OPTIONS = [
  ['unpublished', '未公开'],
  ['published', '已公开'],
  ['revoked', '已撤回'],
] as const

function toShanghaiIso(value: string): string {
  return value ? new Date(`${value}:00+08:00`).toISOString() : ''
}

function fromIso(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
}

function formatSize(value: number | null): string {
  if (value == null) return '—'
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function MultiSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string[]
  options: readonly (readonly [string, string])[]
  onChange: (value: string[]) => void
}) {
  const selectedCount = value.length
  const allSelected = options.length > 0 && selectedCount === options.length

  const toggleOption = (optionValue: string) => {
    onChange(value.includes(optionValue)
      ? value.filter((item) => item !== optionValue)
      : [...value, optionValue])
  }

  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex items-center justify-between gap-1">
        <span className="min-w-0 truncate text-muted-foreground">
          {label}
          <span className="ml-1 text-[11px] text-foreground/70">{selectedCount > 0 ? `已选 ${selectedCount}` : '全部'}</span>
        </span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onChange(options.map(([optionValue]) => optionValue))}
            disabled={allSelected || options.length === 0}
            className="h-5 rounded-none px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            全选
          </button>
          <span className="text-muted-foreground/60">/</span>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={selectedCount === 0}
            className="h-5 rounded-none px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            清空
          </button>
        </span>
      </div>
      <div className="grid max-h-14 grid-cols-2 gap-x-1 overflow-y-auto border p-1">
        {options.length > 0 ? options.map(([optionValue, optionLabel]) => (
          <label key={optionValue} className="flex min-w-0 cursor-pointer items-center gap-1 px-1 py-0.5 hover:bg-accent">
            <input
              type="checkbox"
              checked={value.includes(optionValue)}
              onChange={() => toggleOption(optionValue)}
              className="size-3 shrink-0 accent-primary"
            />
            <span className="truncate">{optionLabel}</span>
          </label>
        )) : (
          <span className="col-span-2 px-1 py-0.5 text-[11px] text-muted-foreground">暂无可选项</span>
        )}
      </div>
    </div>
  )
}

export default function DataExportPanel() {
  const [filter, setFilter] = useState<ExportFilter>(DEFAULT_EXPORT_FILTER)
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([])
  const [jobs, setJobs] = useState<ExportJobDto[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await listDataExportJobs())
    } catch {
      toast.error('导出任务加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([loadJobs(), fetchSources().then((items) => {
      if (active) setSources(items.filter((item) => item.id && item.name).map((item) => ({ id: item.id, name: item.name })))
    }).catch(() => undefined)])
    return () => { active = false }
  }, [loadJobs])

  const hasActiveJob = useMemo(() => jobs.some((job) => job.status === 'queued' || job.status === 'running'), [jobs])
  const sourceOptions = useMemo(() => sources.map((source) => [source.id, source.name] as const), [sources])

  useEffect(() => {
    if (!hasActiveJob) return undefined
    const timer = window.setInterval(() => { void loadJobs() }, 2000)
    return () => window.clearInterval(timer)
  }, [hasActiveJob, loadJobs])

  const updateFilter = <K extends keyof ExportFilter>(key: K, value: ExportFilter[K]) => {
    setFilter((current) => ({ ...current, [key]: value }))
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const job = await createDataExportJob(filter)
      setJobs((current) => [job, ...current].slice(0, 20))
      toast.success('导出任务已创建，后台正在生成')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建导出任务失败')
    } finally {
      setCreating(false)
    }
  }

  const handleAction = async (job: ExportJobDto, action: 'cancel' | 'retry' | 'download' | 'delete') => {
    setActionId(job.id)
    try {
      if (action === 'download') {
        await downloadDataExportFile(job.id)
        return
      }
      if (action === 'delete') {
        await deleteDataExportJob(job.id)
        setJobs((current) => current.filter((item) => item.id !== job.id))
        toast.success('导出任务已删除')
        return
      }
      const next = action === 'cancel' ? await cancelDataExportJob(job.id) : await retryDataExportJob(job.id)
      setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 20))
      toast.success(action === 'cancel' ? '已请求取消导出' : '已重新创建导出任务')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出操作失败')
    } finally {
      setActionId(null)
    }
  }

  return (
    <Card className="rounded-none border shadow-none py-0">
      <CardContent className="space-y-2 p-2.5">
        <div className="flex items-center justify-between border-b pb-1.5">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">文章 Excel 导出</span>
          </div>
          <Button size="sm" variant="ghost" className="h-7 gap-1 rounded-none px-2 text-xs" onClick={() => void loadJobs()} disabled={loading}>
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">日期字段</span>
            <select value={filter.dateField} onChange={(event) => updateFilter('dateField', event.target.value as ExportFilter['dateField'])} className="h-8 w-full rounded-none border bg-background px-2 text-xs">
              <option value="createdAt">进入系统时间</option>
              <option value="publishedAt">发布时间</option>
              <option value="updatedAt">更新时间</option>
            </select>
          </label>
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">开始时间（上海）</span>
            <Input type="datetime-local" value={fromIso(filter.from)} onChange={(event) => updateFilter('from', toShanghaiIso(event.target.value))} className="h-8 rounded-none text-xs" />
          </label>
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">结束时间（上海，不含）</span>
            <Input type="datetime-local" value={fromIso(filter.to)} onChange={(event) => updateFilter('to', toShanghaiIso(event.target.value))} className="h-8 rounded-none text-xs" />
          </label>
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">Event ID（可选）</span>
            <Input value={filter.eventId} onChange={(event) => updateFilter('eventId', event.target.value)} placeholder="按 Event 筛选" className="h-8 rounded-none text-xs" />
          </label>
        </div>

        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>多选筛选</span>
          <span>可同时勾选多个值；未选择表示全部</span>
        </div>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <MultiSelect label="来源" value={filter.sourceIds} options={sourceOptions} onChange={(value) => updateFilter('sourceIds', value)} />
          <MultiSelect label="正文状态" value={filter.fetchStatuses} options={SOURCE_STATUS_OPTIONS} onChange={(value) => updateFilter('fetchStatuses', value as ExportFilter['fetchStatuses'])} />
          <MultiSelect label="AI 状态" value={filter.aiStatuses} options={AI_STATUS_OPTIONS} onChange={(value) => updateFilter('aiStatuses', value as ExportFilter['aiStatuses'])} />
          <MultiSelect label="聚类状态" value={filter.clusterStatuses} options={CLUSTER_STATUS_OPTIONS} onChange={(value) => updateFilter('clusterStatuses', value as ExportFilter['clusterStatuses'])} />
        </div>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <MultiSelect label="公开状态" value={filter.publicStatuses} options={PUBLIC_STATUS_OPTIONS} onChange={(value) => updateFilter('publicStatuses', value as ExportFilter['publicStatuses'])} />
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">代表文章</span>
            <select value={filter.representative} onChange={(event) => updateFilter('representative', event.target.value as ExportFilter['representative'])} className="h-8 w-full rounded-none border bg-background px-2 text-xs">
              <option value="all">全部</option><option value="yes">仅代表</option><option value="no">非代表</option>
            </select>
          </label>
          <label className="space-y-0.5 text-xs">
            <span className="text-muted-foreground">推送状态</span>
            <select value={filter.pushed} onChange={(event) => updateFilter('pushed', event.target.value as ExportFilter['pushed'])} className="h-8 w-full rounded-none border bg-background px-2 text-xs">
              <option value="all">全部</option><option value="yes">已推送</option><option value="no">未推送</option>
            </select>
          </label>
          <label className="flex h-8 items-center gap-2 border px-2 text-xs">
            <input type="checkbox" checked={filter.includeDiscarded} onChange={(event) => updateFilter('includeDiscarded', event.target.checked)} />
            包含未入库条目
          </label>
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-1.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-4 text-muted-foreground">按筛选条件导出文章及处理结果，生成 8 个固定工作表；文件保留 24 小时。</p>
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating} className="h-8 shrink-0 gap-1.5 rounded-none px-3 text-xs">
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            创建 Excel 导出
          </Button>
        </div>

        <div className="space-y-1.5 border-t pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">最近导出任务</span>
            <span className="text-[11px] text-muted-foreground">最多显示 20 条</span>
          </div>
          {loading ? <div className="text-xs text-muted-foreground">加载中…</div> : jobs.length === 0 ? <div className="text-xs text-muted-foreground">暂无任务</div> : jobs.map((job) => {
            const percent = job.progressTotal > 0 ? Math.min(100, Math.round((job.progressDone / job.progressTotal) * 100)) : 0
            return (
              <div key={job.id} className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 border px-2 py-1 text-xs">
                <span className="shrink-0 font-medium">{STATUS_LABELS[job.status] ?? job.status}</span>
                <div className="min-w-0">
                  <div className="truncate">{job.fileName || job.currentItemLabel || '等待处理'}</div>
                  {(job.status === 'queued' || job.status === 'running') && <div className="text-[11px] text-muted-foreground">进度 {percent}%</div>}
                  {job.status === 'succeeded' && <div className="truncate text-[11px] text-muted-foreground">{formatSize(job.fileSizeBytes)} · {formatDate(job.expiresAt)} 过期</div>}
                  {job.status === 'failed' && <div className="max-w-full truncate text-[11px] text-destructive" title={job.error}>{job.error}</div>}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-0.5">
                  {(job.status === 'queued' || job.status === 'running') && <Button variant="ghost" size="sm" className="h-6 gap-1 rounded-none px-1.5 text-xs" disabled={actionId === job.id} onClick={() => void handleAction(job, 'cancel')}><X className="h-3 w-3" />取消</Button>}
                  {job.status === 'succeeded' && <Button variant="ghost" size="sm" className="h-6 gap-1 rounded-none px-1.5 text-xs" disabled={actionId === job.id} onClick={() => void handleAction(job, 'download')}><Download className="h-3 w-3" />下载</Button>}
                  {(job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') && <Button variant="ghost" size="sm" className="h-6 gap-1 rounded-none px-1.5 text-xs" disabled={actionId === job.id} onClick={() => void handleAction(job, 'retry')}><RotateCcw className="h-3 w-3" />重试</Button>}
                  <Button variant="ghost" size="sm" className="h-6 w-6 rounded-none p-0 text-destructive hover:text-destructive" aria-label="删除导出任务" title="删除导出任务" disabled={actionId === job.id} onClick={() => void handleAction(job, 'delete')}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
