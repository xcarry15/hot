import { useState, useMemo, memo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, Loader2, Clock3 } from 'lucide-react'
import { ArticleRow } from './article-row'
import { DiscardedRow } from './discarded-row'
import { DISCARD_REASON_LABELS } from './helpers'
import { hasArticleAnomaly } from './filter'
import type { SourceProgress, DiscardedRow as DiscardedRowType } from './types'
import type { ArticleWorkspacePanel } from '@/components/article-workspace'

function humanizeSourceError(value?: string): string {
  if (!value) return ''
  if (/circuit breaker active/i.test(value)) return '数据源连续失败，暂时熔断'
  if (/source disabled/i.test(value)) return '数据源已停用'
  if (/source not found/i.test(value)) return '数据源不存在或已删除'
  if (/timeout/i.test(value)) return '请求超时，可稍后重试'
  if (/fetch failed|network|econn|socket/i.test(value)) return '网络请求失败，可稍后重试'
  return value.length > 180 ? `${value.slice(0, 180)}…` : value
}

// ========== Source Block ==========

export const SourceBlock = memo(function SourceBlock({
  source,
  summarySource,
  onToggle,
  onStepAction,
  onStepActionLoading,
  onTechnicalStatus,
  onOpenArticle,
  onOpenArticlePanel,
  onOpenDiscarded,
  onDiscardedRetried,
  onRetrySource,
  isJobRunning,
}: {
  source: SourceProgress
  /** 筛选只影响列表；标题统计始终读取该数据源的完整快照。 */
  summarySource?: SourceProgress
  onToggle: () => void
  onStepAction?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => void
  onStepActionLoading?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => boolean
  onTechnicalStatus?: (articleId: string, action: 'ignore' | 'restore') => void
  onOpenArticle?: (articleId: string) => void
  onOpenArticlePanel?: (articleId: string, panel: ArticleWorkspacePanel) => void
  onOpenDiscarded?: (id: string) => void
  onDiscardedRetried?: () => void
  onRetrySource?: (sourceId: string) => void
  /** 批量 Job 运行时禁用单篇动作。 */
  isJobRunning?: boolean
}) {
  const statusIcon = source.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> :
                     source.status === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
                     source.status === 'not-run' ? <Clock3 className="h-4 w-4 text-muted-foreground" /> :
                     source.status === 'warning' ? <Clock3 className="h-4 w-4 text-amber-600" /> :
                     <XCircle className="h-4 w-4 text-destructive" />

  const statusBg = source.status === 'running' ? 'bg-blue-50/80 border-blue-200/50' :
                   source.status === 'success' ? 'bg-emerald-50/80 border-emerald-200/50' :
                   source.status === 'not-run' ? 'bg-muted/50 border-border' :
                   source.status === 'warning' ? 'bg-amber-50/80 border-amber-200/50' :
                   'bg-red-50/80 border-red-200/50'

  const lastRunLabel = source.lastRunStatus === 'success'
    ? `本次发现 ${source.lastRunItemsFound ?? 0}`
    : source.lastRunStatus === 'failed'
      ? '本次失败'
      : source.lastRunStatus === 'warning'
        ? '本次有警告'
        : '未运行'

  // 稳定引用：source.articles 缺失时 `|| []` 会返回新数组，破坏下游 useMemo 的依赖判断
  const articles = useMemo(() => source.articles ?? [], [source.articles])
  const [collapsedDiscardGroups, setCollapsedDiscardGroups] = useState<Set<string>>(() => new Set())
  const summaryArticles = summarySource?.articles ?? articles
  const totalCount = summaryArticles.length
  const manualCount = summaryArticles.filter(a => a.technicalState === 'manual').length
  const autoRetryCount = summaryArticles.filter(a => a.technicalState === 'auto_retry').length
  const pushedCount = summaryArticles.filter(a => a.push === 'done').length
  const anomalyCount = summaryArticles.filter(hasArticleAnomaly).length
  const discardedCount = summarySource?.discarded?.length ?? source.discarded?.length ?? 0

  // 按 reason 分组，组内按 publishedAt desc 排序
  const discardedGroups = useMemo(() => {
    const discarded = source.discarded || []
    const groups = new Map<string, DiscardedRowType[]>()
    for (const item of discarded) {
      const list = groups.get(item.reason) || []
      list.push(item)
      groups.set(item.reason, list)
    }
    for (const items of groups.values()) {
      items.sort((a, b) => {
        const da = a.publishedAt || a.createdAt || ''
        const db = b.publishedAt || b.createdAt || ''
        return db.localeCompare(da)
      })
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === 'filter:keyword') return -1
      if (b[0] === 'filter:keyword') return 1
      return b[1].length - a[1].length
    })
  }, [source.discarded])

  const toggleDiscardGroup = useCallback((reason: string) => {
    setCollapsedDiscardGroups(prev => {
      const next = new Set(prev)
      if (next.has(reason)) next.delete(reason)
      else next.add(reason)
      return next
    })
  }, [])

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-sm border-b ${statusBg} hover:opacity-80 transition-opacity`}
      >
        {statusIcon}
        <span className="font-semibold truncate">{source.name}</span>
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 rounded-full ${source.lastRunStatus === 'failed' ? 'bg-red-100 text-red-700' : source.lastRunStatus === 'success' ? 'bg-emerald-100 text-emerald-700' : 'text-muted-foreground'}`}
            title={humanizeSourceError(source.lastRunError) || '源级最近一次采集结果'}
          >
            {lastRunLabel}
          </Badge>
          <span className="text-muted-foreground text-xs">文章 {totalCount}</span>
          <span className="text-xs text-emerald-700">推送 {pushedCount}</span>
          <span className={`text-xs ${anomalyCount > 0 ? 'font-medium text-red-700' : 'text-muted-foreground'}`}>异常 {anomalyCount}</span>
          {manualCount > 0 && <span className="text-xs font-medium text-red-700">需处理 {manualCount}</span>}
          {autoRetryCount > 0 && <span className="text-xs font-medium text-blue-700">自动恢复 {autoRetryCount}</span>}
          {discardedCount > 0 && <span className="text-xs text-muted-foreground">未入库 {discardedCount}</span>}
        </div>
      </button>

      {source.expanded && articles.length > 0 && (
        <div className="bg-background/50">
          <div className="overflow-y-auto max-h-[50vh] sm:max-h-none divide-y divide-border/20">
            {articles.map(article => (
              <ArticleRow
                key={article.id}
                article={article}
                onStepAction={onStepAction}
                onStepActionLoading={onStepActionLoading}
                onTechnicalStatus={onTechnicalStatus}
                onOpenArticle={onOpenArticle}
                onOpenArticlePanel={onOpenArticlePanel}
                isJobRunning={isJobRunning}
              />
            ))}
          </div>
        </div>
      )}

      {source.expanded && (source.discarded?.length ?? 0) > 0 && (
        <div className="border-t border-dashed bg-muted/20 px-2 py-1">
          <div className="overflow-y-auto max-h-[50vh] sm:max-h-none">
              {discardedGroups.map(([reason, items]) => {
                const groupLabel = DISCARD_REASON_LABELS[reason] || reason
                const isExpanded = !collapsedDiscardGroups.has(reason)
                return (
                  <div key={reason}>
                    <button
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full py-0.5"
                      onClick={() => toggleDiscardGroup(reason)}
                    >
                      <span>{isExpanded ? '▾' : '▸'}</span>
                      <span>{groupLabel}</span>
                      <span className="text-muted-foreground/60">({items.length})</span>
                    </button>
                    {isExpanded && (
                      <div className="divide-y divide-border/30 ml-2">
                        {items.map(item => (
                          <DiscardedRow
                            key={item.id}
                            item={item}
                            onOpen={onOpenDiscarded}
                            onRetried={onDiscardedRetried}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {source.error && (
        <div className="px-2 py-1 text-xs text-destructive bg-red-50/50">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words">{humanizeSourceError(source.error)}</span>
            {onRetrySource && (
              <button
                type="button"
                className="shrink-0 rounded border border-destructive/30 px-1.5 py-0.5 hover:bg-red-100"
                onClick={(event) => { event.stopPropagation(); onRetrySource(source.id) }}
                disabled={isJobRunning}
              >
                重试此源
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
