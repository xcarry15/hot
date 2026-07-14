'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { fetchDashboard, fetchDedupStats } from '@/features/dashboard-api.client'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Activity,
  Bot,
  Send,
  AlertTriangle,
  ShieldAlert,
  Zap,
  RefreshCw,
  Fingerprint,
} from 'lucide-react'
import { toast } from 'sonner'

interface DashboardData {
  breakerSources: number
  pendingProcess: number
  pendingAi: number
  failedAi: number
  failedPush: number
  urgentUnpushed: number
  recentTaskFailures: number
  recentFetchFailures: number
}

interface DedupData {
  todayCount: number
  allTimeTotal: number
  avgSimilarity: number
  byType: Record<string, { count: number; avgSimilarity: number }>
}

export default function DashboardTab() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [dedupData, setDedupData] = useState<DedupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [dashJson, dedupJson] = await Promise.all([
        fetchDashboard(),
        fetchDedupStats().catch(() => null),
      ])
      setData(dashJson as unknown as Parameters<typeof setData>[0])
      if (dedupJson) setDedupData(dedupJson as unknown as Parameters<typeof setDedupData>[0])
    } catch {
      toast.error('获取概览数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(fetchData, 0)
    return () => clearTimeout(handle)
  }, [fetchData])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 30000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, fetchData])

  if (loading) {
    return (
      <div className="space-y-4 p-3 sm:p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="py-0">
              <CardContent className="p-4 space-y-3">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className="py-0">
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!data) return null

  const statCards = [
    { label: '熔断源', value: data.breakerSources, icon: AlertTriangle, color: 'text-red-600' },
    { label: '待处理', value: data.pendingProcess, icon: Activity, color: 'text-blue-600' },
    { label: '待AI', value: data.pendingAi, icon: Bot, color: 'text-amber-600' },
    { label: 'AI失败', value: data.failedAi, icon: ShieldAlert, color: 'text-orange-600' },
    { label: '推送失败', value: data.failedPush, icon: Send, color: 'text-red-600' },
    { label: '高分待推', value: data.urgentUnpushed, icon: Zap, color: 'text-violet-600' },
  ]

  return (
    <div className="space-y-4 p-3 sm:p-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 text-xs gap-1.5"
            onClick={fetchData}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
          <button
            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${autoRefresh ? 'bg-emerald-100 text-emerald-700 font-medium' : 'bg-muted text-muted-foreground'}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-pressed={autoRefresh}
            aria-label="自动刷新"
          >
            {autoRefresh ? '自动刷新 开' : '自动刷新 关'}
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((card) => (
          <Card key={card.label} className="py-0">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
                <card.icon className={`h-4 w-4 ${card.color}`} />
              </div>
              <div className="text-2xl font-semibold tracking-tight">{card.value.toLocaleString()}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Dedup Stats — Today */}
      {dedupData && dedupData.todayCount > 0 && (
        <Card className="py-0">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Fingerprint className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">今日去重</span>
              <Badge variant="secondary" className="text-xs px-2 py-0">{dedupData.todayCount} 条</Badge>
              {dedupData.allTimeTotal > dedupData.todayCount && (
                <span className="text-xs text-muted-foreground ml-1">累计 {dedupData.allTimeTotal}</span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Object.entries(dedupData.byType).map(([type, info]) => (
                <div key={type} className="text-sm">
                  <div className="text-muted-foreground truncate text-xs">
                    {type === 'url_exact' ? 'URL精确' : type === 'title_similar' ? '标题相似' : type === 'content_fingerprint' ? '内容指纹' : '近重复'}
                  </div>
                  <div className="font-medium">{info.count} 条</div>
                  <div className="text-xs text-muted-foreground">相似度 {(info.avgSimilarity * 100).toFixed(0)}%</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.recentTaskFailures > 0 && (
        <Card className="py-0 border-destructive/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">近24小时任务异常</span>
              <Badge variant="destructive" className="text-xs px-2 py-0">{data.recentTaskFailures}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">请到抓取记录页面定位失败任务。</p>
          </CardContent>
        </Card>
      )}

      {data.recentFetchFailures > 0 && (
        <Card className="py-0 border-amber-300/50">
          <CardContent className="p-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="text-sm text-amber-700">近24小时数据源失败 {data.recentFetchFailures} 次，请检查源状态与抓取日志。</span>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
