'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LoadingList } from '@/components/ui/loading-list'
import { ScoreBadge } from '@/components/ui/score-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { formatRelativeTime } from '@/lib/shared/date'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { fetchPushLog, fetchPushLogStats } from '@/features/push-log-api.client'
import { cn } from '@/lib/utils'

interface PushLog {
  id: string
  articleId: string
  status: string
  errorMessage: string
  retryCount: number
  webhookTarget: string
  webhookRemark: string
  createdAt: string
  article: {
    title: string
    url: string
    brand: string
    category: string
    score: number
    publishedAt: string | null
    source: { name: string }
  }
}

interface PushLogResponse {
  items: PushLog[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

interface PushLogStats {
  status: { all: number; success: number; failure: number }
  sources: { name: string; count: number }[]
  webhooks: { remark: string; count: number }[]
}

export default function PushLogTab() {
  const [data, setData] = useState<PushLogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [webhookFilter, setWebhookFilter] = useState<string>('all')
  const [stats, setStats] = useState<PushLogStats | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const data = await fetchPushLogStats()
      setStats(data as unknown as PushLogStats | null)
    } catch {
      // silent fail for stats
    }
  }, [])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const json = await fetchPushLog({
        page,
        pageSize: 20,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        source: sourceFilter !== 'all' ? sourceFilter : undefined,
        webhookRemark: webhookFilter !== 'all' ? webhookFilter : undefined,
      })
      setData(json as unknown as Parameters<typeof setData>[0])
    } catch (err) {
      toast.error('推送日志加载失败')
      console.error('[push-log-tab] fetchLogs failed:', err)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, sourceFilter, webhookFilter])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  useEffect(() => {
    const handle = setTimeout(fetchLogs, 0)
    return () => clearTimeout(handle)
  }, [fetchLogs])

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="p-3 sm:p-4 border-b flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-[100px] text-xs">
            <SelectValue placeholder="推送状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 {stats ? `(${stats.status.all})` : ''}</SelectItem>
            <SelectItem value="success">成功 {stats ? `(${stats.status.success})` : ''}</SelectItem>
            <SelectItem value="failure">失败 {stats ? `(${stats.status.failure})` : ''}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-[120px] text-xs">
            <SelectValue placeholder="数据源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部数据源</SelectItem>
            {stats?.sources.map(s => (
              <SelectItem key={s.name} value={s.name}>
                {s.name} ({s.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={webhookFilter} onValueChange={(v) => { setWebhookFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-[120px] text-xs">
            <SelectValue placeholder="推送群" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部推送群</SelectItem>
            {stats?.webhooks.map(w => (
              <SelectItem key={w.remark} value={w.remark}>
                {w.remark} ({w.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {data && (
          <span className="text-xs text-muted-foreground ml-auto">共 {data.total} 条记录</span>
        )}
      </div>

      {/* Log List */}
      <ScrollArea className="flex-1 h-full">
        {loading ? (
          <LoadingList count={10} />
        ) : data && data.items.length > 0 ? (
          <div className="divide-y">
            {data.items.map((log) => (
              <div
                key={log.id}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 hover:bg-muted/30 transition-colors text-xs border-l-2',
                  log.status === 'success' ? 'border-l-emerald-500' : 'border-l-destructive'
                )}
              >
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-12">
                  {formatRelativeTime(log.createdAt)}
                </span>
                <span className="font-medium truncate flex-1 min-w-0">{log.article.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {log.article.source.name}
                </span>
                {log.webhookRemark && (
                  <span className="shrink-0 text-[11px] text-muted-foreground truncate max-w-[60px]">{log.webhookRemark}</span>
                )}
                {log.retryCount > 0 && (
                  <span className="text-amber-500 shrink-0 text-[11px]">重试{log.retryCount}次</span>
                )}
                {log.article.publishedAt && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {new Date(log.article.publishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {log.status === 'success' ? (
                  <ScoreBadge score={log.article.score} variant="text" />
                ) : (
                  <span className="text-destructive shrink-0 text-[11px]">{log.errorMessage || '推送失败'}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="暂无推送记录"
            description="文章完成 AI 分析并触发推送后会出现在这里"
            className="p-8"
          />
        )}
      </ScrollArea>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between p-3 border-t">
          <span className="text-xs text-muted-foreground">
            第 {data.page}/{data.totalPages} 页
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              aria-label="上一页"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5"
              disabled={page >= data.totalPages}
              onClick={() => setPage(p => p + 1)}
              aria-label="下一页"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
