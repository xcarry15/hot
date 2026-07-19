'use client'

import { useCallback, useEffect, useState } from 'react'
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
  webhooks: { remark: string; count: number }[]
}

function formatPushTime(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

function pushStatusLabel(status: string): string {
  return status === 'success' ? '成功' : '失败'
}

export default function PushLogPanel({ active = true, refreshToken = 0 }: { active?: boolean; refreshToken?: number }) {
  const [data, setData] = useState<PushLogResponse | null>(null)
  const [stats, setStats] = useState<PushLogStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [webhookFilter, setWebhookFilter] = useState('all')

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchPushLog({
        page,
        pageSize: 20,
        status: statusFilter === 'all' ? undefined : statusFilter,
        source: sourceFilter === 'all' ? undefined : sourceFilter,
        webhookRemark: webhookFilter === 'all' ? undefined : webhookFilter,
      })
      setData(result as unknown as PushLogResponse)
    } catch (error) {
      toast.error('推送记录加载失败')
      console.error('[push-log-panel] fetchLogs failed:', error)
    } finally {
      setLoading(false)
    }
  }, [page, sourceFilter, statusFilter, webhookFilter])

  useEffect(() => {
    if (!active || stats) return
    void fetchPushLogStats()
      .then((result) => setStats(result as unknown as PushLogStats))
      .catch(() => undefined)
  }, [active, stats])

  useEffect(() => {
    if (!active) return
    const handle = setTimeout(() => { void fetchLogs() }, 0)
    const interval = setInterval(() => { void fetchLogs() }, 30000)
    return () => {
      clearTimeout(handle)
      clearInterval(interval)
    }
  }, [active, fetchLogs])

  useEffect(() => {
    if (!active || refreshToken === 0) return
    void fetchLogs()
  }, [active, fetchLogs, refreshToken])

  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value)
    setPage(1)
  }

  return (
    <Card className="py-0">
      <CardContent className="p-2.5">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <div className="mr-2 shrink-0">
            <h3 className="text-sm font-medium">推送记录</h3>
            <p className="text-[10px] text-muted-foreground">
              {stats ? `全量 ${stats.status.all} 条 · 成功 ${stats.status.success} · 失败 ${stats.status.failure}` : '全量记录每次 Webhook 目标投递结果'}
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
              {stats?.webhooks.map((webhook) => <SelectItem key={webhook.remark} value={webhook.remark}>{webhook.remark} ({webhook.count})</SelectItem>)}
            </SelectContent>
          </Select>
          {data && <span className="ml-auto text-[11px] text-muted-foreground">当前 {data.total} 条</span>}
        </div>

        {loading ? (
          <LoadingList count={6} />
        ) : data && data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] whitespace-nowrap border-collapse text-[11px]">
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
                    <td className="max-w-[180px] px-1.5 py-1">
                      <div className="max-w-[180px] truncate font-medium" title={log.webhookTarget || undefined}>{log.webhookRemark || '飞书 Webhook'} <span className="font-normal text-muted-foreground">· {log.webhookTarget || '未记录目标'}</span></div>
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
