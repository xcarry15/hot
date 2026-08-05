'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingList } from '@/components/ui/loading-list'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { fetchPushLog, fetchPushLogStats } from '@/features/push-log-api.client'
import { isRequestAborted, isRequestJsonError } from '@/lib/request-json.client'

interface PushLog {
  id: string
  status: string
  errorMessage: string
  retryCount: number
  webhookTarget: string
  webhookRemark: string
  createdAt: string
  article: {
    title: string
    score: number
    source: { name: string }
  } | null
}

interface PushLogResponse {
  items: PushLog[]
  total: number
  page: number
  totalPages: number
}

interface PushLogStats {
  status: { all: number; success: number; failure: number }
  sources: { name: string; count: number }[]
  webhooks: { remark: string; isEmpty: boolean; count: number }[]
}

function formatPushTime(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

function pushStatusLabel(status: string): string {
  return status === 'success' ? '成功' : '失败'
}

const HIDDEN_WEBHOOK_LABEL = '已隐藏的 Webhook'
const EMPTY_WEBHOOK_FILTER = 'empty'
const WEBHOOK_REMARK_FILTER_PREFIX = 'remark:'

function visibleWebhookValue(value: string): string {
  return value === HIDDEN_WEBHOOK_LABEL ? '' : value
}

function toWebhookRemarkFilter(remark: string): string {
  return `${WEBHOOK_REMARK_FILTER_PREFIX}${encodeURIComponent(remark)}`
}

function getWebhookFilterParams(value: string): { webhookRemark?: string; emptyWebhookRemark?: boolean } {
  if (value === EMPTY_WEBHOOK_FILTER) return { emptyWebhookRemark: true }
  if (!value.startsWith(WEBHOOK_REMARK_FILTER_PREFIX)) return {}
  try {
    return { webhookRemark: decodeURIComponent(value.slice(WEBHOOK_REMARK_FILTER_PREFIX.length)) }
  } catch {
    return {}
  }
}

interface PushLogPanelProps {
  active?: boolean
  refreshToken?: number
  startAt?: string | null
  endAt?: string | null
}

export default function PushLogPanel({ active = true, refreshToken = 0, startAt = null, endAt = null }: PushLogPanelProps) {
  const [data, setData] = useState<PushLogResponse | null>(null)
  const [stats, setStats] = useState<PushLogStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [webhookFilter, setWebhookFilter] = useState('all')
  const logRequestRef = useRef<AbortController | null>(null)

  const fetchLogs = useCallback(async (background = false) => {
    logRequestRef.current?.abort()
    const controller = new AbortController()
    logRequestRef.current = controller
    if (!background) setLoading(true)

    const params = {
      page,
      pageSize: 20,
      status: statusFilter === 'all' ? undefined : statusFilter,
      source: sourceFilter === 'all' ? undefined : sourceFilter,
      ...getWebhookFilterParams(webhookFilter),
      startAt: startAt ?? undefined,
      endAt: endAt ?? undefined,
    }

    try {
      let result: Awaited<ReturnType<typeof fetchPushLog>>
      try {
        result = await fetchPushLog(params, controller.signal)
      } catch (error) {
        // Next dev 热更新、切页或本机连接短暂重置时，浏览器常把失败表现为
        // status=0 的 “Failed to fetch”。只对这类瞬时网络错误重试一次。
        if (!isRequestJsonError(error, 0) || controller.signal.aborted) throw error
        await new Promise<void>((resolve) => window.setTimeout(resolve, 300))
        if (controller.signal.aborted) return
        result = await fetchPushLog(params, controller.signal)
      }
      if (!controller.signal.aborted) setData(result as unknown as PushLogResponse)
    } catch (error) {
      if (isRequestAborted(error) || controller.signal.aborted) return
      toast.error('推送记录加载失败')
      console.error('[push-log-panel] fetchLogs failed:', error)
    } finally {
      if (logRequestRef.current === controller) {
        logRequestRef.current = null
        if (!controller.signal.aborted) setLoading(false)
      }
    }
  }, [endAt, page, sourceFilter, startAt, statusFilter, webhookFilter])

  useEffect(() => {
    if (!active) return
    setStats(null)
    const controller = new AbortController()
    void fetchPushLogStats({ startAt: startAt ?? undefined, endAt: endAt ?? undefined }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setStats(result as unknown as PushLogStats)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [active, endAt, startAt])

  useEffect(() => {
    if (!active) return
    const handle = setTimeout(() => { void fetchLogs() }, 0)
    const interval = setInterval(() => { void fetchLogs(true) }, 30000)
    return () => {
      clearTimeout(handle)
      clearInterval(interval)
      logRequestRef.current?.abort()
    }
  }, [active, fetchLogs])

  useEffect(() => {
    if (!active || refreshToken === 0) return
    void fetchLogs()
  }, [active, fetchLogs, refreshToken])

  useEffect(() => () => {
    logRequestRef.current?.abort()
  }, [])

  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value)
    setPage(1)
  }

  return (
    <Card className="h-[420px] overflow-y-auto py-0">
      <CardContent className="p-2">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <div className="mr-2 shrink-0">
            <h3 className="text-sm font-medium">推送记录</h3>
            <p className="text-[10px] text-muted-foreground">
              {stats ? `当前范围 ${stats.status.all} 条 · 成功 ${stats.status.success} · 失败 ${stats.status.failure}` : '当前范围内的 Webhook 投递结果'}
            </p>
          </div>
          <Select value={statusFilter} onValueChange={(value) => updateFilter(setStatusFilter, value)}>
            <SelectTrigger className="h-7 w-[90px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="结果" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="failure">失败</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={(value) => updateFilter(setSourceFilter, value)}>
            <SelectTrigger className="h-7 w-[130px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="数据源" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部数据源</SelectItem>
              {stats?.sources.map((source) => <SelectItem key={source.name} value={source.name}>{source.name} ({source.count})</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={webhookFilter} onValueChange={(value) => updateFilter(setWebhookFilter, value)}>
            <SelectTrigger className="h-7 w-[130px] rounded-none border-border bg-transparent text-[11px] shadow-none focus:ring-1"><SelectValue placeholder="推送方式" /></SelectTrigger>
            <SelectContent className="rounded-none shadow-sm">
              <SelectItem value="all">全部方式</SelectItem>
              {stats?.webhooks.map((webhook) => <SelectItem key={`${webhook.isEmpty}:${webhook.remark}`} value={webhook.isEmpty ? EMPTY_WEBHOOK_FILTER : toWebhookRemarkFilter(webhook.remark)}>{webhook.remark} ({webhook.count})</SelectItem>)}
            </SelectContent>
          </Select>
          {data && <span className="ml-auto text-[11px] text-muted-foreground">当前 {data.total} 条</span>}
        </div>

        {loading ? (
          <LoadingList count={6} />
        ) : data && data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] whitespace-nowrap border-collapse text-[11px]">
              <thead>
                <tr className="border-b text-left text-[11px] text-muted-foreground">
                  <th className="px-1.5 py-1 font-medium">推送时间</th>
                  <th className="px-1.5 py-1 font-medium">推送方式</th>
                  <th className="px-1.5 py-1 font-medium">数据源 / 文章</th>
                  <th className="px-1.5 py-1 font-medium">结果</th>
                  <th className="px-1.5 py-1 font-medium">重试</th>
                  <th className="px-1.5 py-1 font-medium">分数 / 错误</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((log) => (
                  <tr key={log.id} className="border-b last:border-0" title={log.errorMessage || undefined}>
                    <td className="px-1.5 py-1 tabular-nums">{formatPushTime(log.createdAt)}</td>
                    <td className="w-[90px] max-w-[90px] px-1.5 py-1">
                      <div className="max-w-[90px] truncate font-medium" title={visibleWebhookValue(log.webhookTarget) || undefined}>
                        {visibleWebhookValue(log.webhookRemark) || (visibleWebhookValue(log.webhookTarget) ? '飞书 Webhook' : '')}
                        {visibleWebhookValue(log.webhookTarget) && <span className="font-normal text-muted-foreground"> · {visibleWebhookValue(log.webhookTarget)}</span>}
                      </div>
                    </td>
                    <td className="max-w-[320px] px-1.5 py-1">
                      {log.article
                        ? <div className="max-w-[320px] truncate font-medium" title={log.article.title}><span className="font-normal text-muted-foreground">{log.article.source.name} · </span>{log.article.title}</div>
                        : <span className="text-muted-foreground">发送时文章已删除</span>}
                    </td>
                    <td className="px-1.5 py-1">
                      <Badge variant={log.status === 'success' ? 'secondary' : 'destructive'} className="px-1.5 py-0 text-[10px]">{pushStatusLabel(log.status)}</Badge>
                    </td>
                    <td className="px-1.5 py-1 tabular-nums">{log.retryCount > 0 ? <span className="text-amber-600">{log.retryCount} 次</span> : '—'}</td>
                    <td className="max-w-[200px] px-1.5 py-1">
                      {log.status === 'success'
                        ? <span className="tabular-nums">{log.article ? `${log.article.score} 分` : '—'}</span>
                        : <span className="truncate text-destructive" title={log.errorMessage}>{log.errorMessage || '推送失败'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-5 text-center text-xs text-muted-foreground">暂无符合条件的推送记录</div>
        )}

        {data && data.totalPages > 1 && (
          <div className="mt-1.5 flex items-center justify-between border-t pt-1.5">
            <span className="text-[11px] text-muted-foreground">第 {data.page}/{data.totalPages} 页</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
