import { useState, useMemo, memo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, Loader2, Clock3, type LucideIcon } from 'lucide-react'
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

const SOURCE_STATUS_CONFIG: Record<SourceProgress['status'], { icon: LucideIcon; iconClass: string; panelClass: string }> = {
  running: { icon: Loader2, iconClass: 'animate-spin text-blue-600', panelClass: 'bg-blue-50/80 border-blue-200/50' },
  success: { icon: CheckCircle2, iconClass: 'text-emerald-600', panelClass: 'bg-emerald-50/80 border-emerald-200/50' },
  'not-run': { icon: Clock3, iconClass: 'text-muted-foreground', panelClass: 'bg-muted/50 border-border' },
  warning: { icon: Clock3, iconClass: 'text-amber-600', panelClass: 'bg-amber-50/80 border-amber-200/50' },
  error: { icon: XCircle, iconClass: 'text-destructive', panelClass: 'bg-red-50/80 border-red-200/50' },
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
  keywordCategories,
  onKeywordAdded,
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
  keywordCategories?: string[]
  onKeywordAdded?: (category: string) => void
  onRetrySource?: (sourceId: string) => void
  /** 批量 Job 运行时禁用单篇动作。 */
  isJobRunning?: boolean
}) {
  const statusConfig = SOURCE_STATUS_CONFIG[source.status]
  const StatusIcon = statusConfig.icon

  const lastRunLabel = source.lastRunStatus === 'success'
    ? `本次发现 ${source.lastRunItemsFound ?? 0}`
    : source.lastRunStatus === 'failed'
      ? '本次失败'
      : source.lastRunStatus === 'warning'
        ? '本次有警告'
        : '未运行'

  // 保持缺失文章列表的空数组引用稳定，避免破坏下游 useMemo 的依赖判断。
  const articles = useMemo(() => source.articles ?? [], [source.articles])
  const summaryArticles = summarySource?.articles ?? articles
  const totalCount = summaryArticles.length
  const articleMetrics = useMemo(() => {
    let manualCount = 0
    let autoRetryCount = 0
    let publicCount = 0
    let pushedCount = 0
    let anomalyCount = 0

    for (const article of summaryArticles) {
      if (article.technicalState === 'manual') manualCount += 1
      if (article.technicalState === 'auto_retry') autoRetryCount += 1
      if (article.isPublic) publicCount += 1
      if (article.push === 'done') pushedCount += 1
      if (hasArticleAnomaly(article)) anomalyCount += 1
    }

    return { manualCount, autoRetryCount, publicCount, pushedCount, anomalyCount }
  }, [summaryArticles])
  const { manualCount, autoRetryCount, publicCount, pushedCount, anomalyCount } = articleMetrics
  const visibleDiscardedCount = source.discarded?.length ?? 0

  const [collapsedArticleGroups, setCollapsedArticleGroups] = useState<Set<string>>(() => new Set())
  // 按 reason 分组，组内按 publishedAt desc 排序
  const discardedGroups = useMemo(() => {
    const discarded = source.discarded ?? []
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

  const blacklistItems = useMemo(
    () => discardedGroups.find(([reason]) => reason === 'filter:blacklist')?.[1] ?? [],
    [discardedGroups],
  )
  const normalDiscardGroups = useMemo(
    () => discardedGroups.filter(([reason]) => reason !== 'filter:blacklist'),
    [discardedGroups],
  )

  const toggleArticleGroup = useCallback((group: string) => {
    setCollapsedArticleGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  const renderGroupHeader = (group: string, label: string, count: number) => {
    const isExpanded = !collapsedArticleGroups.has(group)
    return (
      <button
        type="button"
        className="flex w-full items-center gap-1 border-b border-border/40 px-2 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => toggleArticleGroup(group)}
        aria-expanded={isExpanded}
      >
        <span>{isExpanded ? '▾' : '▸'}</span>
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground/60">({count})</span>
      </button>
    )
  }

  const renderDiscardedGroup = (reason: string, items: DiscardedRowType[], isBlacklist = false) => {
    const group = isBlacklist ? 'blacklist' : `discarded:${reason}`
    const groupLabel = DISCARD_REASON_LABELS[reason] || reason

    return (
      <div
        key={group}
        className={`border-t border-dashed ${isBlacklist ? 'bg-red-50/30 dark:bg-red-950/10' : 'bg-muted/20'}`}
      >
        {renderGroupHeader(group, groupLabel, items.length)}
        {!collapsedArticleGroups.has(group) && (
          <div className="divide-y divide-border/30 px-1 py-0.5">
            {items.map(item => (
              <DiscardedRow
                key={item.id}
                item={item}
                onOpen={onOpenDiscarded}
                onRetried={onDiscardedRetried}
                keywordCategories={keywordCategories}
                onKeywordAdded={onKeywordAdded}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden rounded-none border border-border bg-card">
      <button
        onClick={onToggle}
        className={`w-full flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b px-2 py-1.5 text-left text-sm ${statusConfig.panelClass} transition-opacity hover:opacity-80`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusIcon className={`h-4 w-4 ${statusConfig.iconClass}`} />
          <span className="min-w-0 truncate font-semibold">{source.name}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Badge
            variant="secondary"
            className={`rounded-none px-1.5 py-0 text-[10px] ${source.lastRunStatus === 'failed' ? 'bg-red-100 text-red-700' : source.lastRunStatus === 'success' ? 'bg-emerald-100 text-emerald-700' : 'text-muted-foreground'}`}
            title={humanizeSourceError(source.lastRunError) || '源级最近一次采集结果'}
          >
            {lastRunLabel}
          </Badge>
          <span className="text-xs text-muted-foreground">文章 {totalCount}</span>
          <span className="text-xs text-sky-700">公开 {publicCount}</span>
          <span className="text-xs text-emerald-700">推送 {pushedCount}</span>
          <span className={`text-xs ${anomalyCount > 0 ? 'font-medium text-red-700' : 'text-muted-foreground'}`}>异常 {anomalyCount}</span>
          {manualCount > 0 && <span className="text-xs font-medium text-red-700">需人工处理 {manualCount}</span>}
          {autoRetryCount > 0 && <span className="text-xs font-medium text-blue-700">自动恢复 {autoRetryCount}</span>}
        </div>
      </button>

      {source.expanded && (articles.length > 0 || visibleDiscardedCount > 0) && (
        <div className="bg-background/50">
          {articles.length > 0 && (
            <div className="border-t border-border/40">
              {renderGroupHeader('articles', '正常文章', articles.length)}
              {!collapsedArticleGroups.has('articles') && (
                <div className="w-full min-w-0 max-w-full divide-y divide-border/20">
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
              )}
            </div>
          )}

          {normalDiscardGroups.map(([reason, items]) => renderDiscardedGroup(reason, items))}

          {blacklistItems.length > 0 && renderDiscardedGroup('filter:blacklist', blacklistItems, true)}
        </div>
      )}

      {source.error && (
        <div className="px-2 py-1 text-xs text-destructive bg-red-50/50">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words">{humanizeSourceError(source.error)}</span>
            {onRetrySource && (
              <button
                type="button"
                className="shrink-0 rounded-none border border-destructive/30 px-1.5 py-0.5 hover:bg-red-100"
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
