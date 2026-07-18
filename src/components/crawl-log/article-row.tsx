import { memo, useCallback } from 'react'
import { ScoreBadge } from '@/components/ui/score-badge'
import { formatPubDate } from './helpers'
import { StepIndicator, SkipBadge } from './step-indicator'
import type { ArticleProgress } from './types'

// ========== Article Row ==========

export const ArticleRow = memo(function ArticleRow({
  article,
  onStepAction,
  onStepActionLoading,
  onOpenArticle,
  isJobRunning,
}: {
  article: ArticleProgress
  onStepAction?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => void
  onStepActionLoading?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => boolean
  onOpenArticle?: (articleId: string) => void
  /** P1-1: 批量 Job 运行时，单篇动作禁用，避免并发冲突 */
  isJobRunning?: boolean
}) {
  const isSkipped = article.crawl === 'skipped'
  const pubDate = formatPubDate(article.publishedAt)


  const nextAction = article.process === 'failed'
    ? { step: 'process' as const, label: '重试处理' }
    : article.cluster === 'failed'
      ? { step: 'cluster' as const, label: '重试聚类' }
      : article.ai === 'failed' || (article.ai === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))
          ? { step: 'ai' as const, label: '重试 AI' }
          : article.push === 'failed'
            ? { step: 'push' as const, label: article.pushRetryAt && new Date(article.pushRetryAt) > new Date() ? '等待重试' : '重试投递' }
            : null

  const handleNextAction = useCallback(() => {
    if (!nextAction) return
    onStepAction?.(article.id, nextAction.step)
  }, [article.id, nextAction, onStepAction])

  const handleOpen = useCallback(() => {
    onOpenArticle?.(article.id)
  }, [onOpenArticle, article.id])

  const processLoading = onStepActionLoading?.(article.id, 'process') ?? false
  const clusterLoading = onStepActionLoading?.(article.id, 'cluster') ?? false
  const aiLoading = onStepActionLoading?.(article.id, 'ai') ?? false
  const pushLoading = onStepActionLoading?.(article.id, 'push') ?? false
  const nextActionLoading = nextAction?.step === 'process'
    ? processLoading
    : nextAction?.step === 'cluster'
      ? clusterLoading
      : nextAction?.step === 'ai'
        ? aiLoading
        : nextAction?.step === 'push'
          ? pushLoading
          : false
  const pushWaiting = nextAction?.step === 'push'
    && Boolean(article.pushRetryAt && new Date(article.pushRetryAt) > new Date())
  const canRunNextAction = Boolean(nextAction) && !isJobRunning && !nextActionLoading && !pushWaiting
  const actionFor = (step: 'process' | 'cluster' | 'ai' | 'push') =>
    nextAction?.step === step && canRunNextAction ? handleNextAction : undefined

  return (
    <div className={`group flex min-h-6 items-center gap-1 border-l-2 border-l-transparent px-2 py-0.5 text-[12px] leading-5 overflow-hidden whitespace-nowrap transition-colors hover:border-l-blue-500 hover:bg-blue-100/80 hover:shadow-[inset_0_1px_0_rgba(59,130,246,0.12),inset_0_-1px_0_rgba(59,130,246,0.12)] ${
      isSkipped ? 'opacity-50' : ''
    }`}>
      {pubDate && (
        <span
          className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums font-mono"
          title={article.publishedAt || ''}
        >
          {pubDate}
        </span>
      )}
      {article.ai === 'done' && article.score != null && (
        <span aria-label={`评分 ${article.score} 分`} title={`AI 分析完成，最终评分 ${article.score} 分`}>
          <ScoreBadge score={article.score} variant="compact-square" />
        </span>
      )}
      {article.clusterStatus === 'needs_review' && (
        <span className="shrink-0 bg-amber-100 px-1 text-[10px] leading-5 text-amber-800">待复核</span>
      )}
      <button
        className="truncate min-w-0 flex-1 text-muted-foreground group-hover:text-foreground text-left"
        title={article.title}
        onClick={handleOpen}
      >
        {article.title}
      </button>
      {(isSkipped || article.ai === 'skipped') && article.skipReason && (
        <SkipBadge reason={article.skipReason} />
      )}
      <div className="flex items-center gap-0.5 shrink-0 group-hover:ring-1 group-hover:ring-blue-300 group-hover:ring-offset-1">
        <StepIndicator label="采集" status={article.crawl} />
        <StepIndicator
          label="处理"
          status={processLoading ? 'running' : article.process}
          onClick={actionFor('process')}
          forceLabel={nextAction?.step === 'process' ? '重试' : undefined}
          title={article.process === 'failed' ? '点击重试处理' : undefined}
        />
        <StepIndicator
          label="聚类"
          status={clusterLoading ? 'running' : article.cluster}
          onClick={actionFor('cluster')}
          forceLabel={nextAction?.step === 'cluster' ? '重试' : undefined}
          title={article.clusterStatus === 'needs_review'
            ? '聚类结果存在歧义，请到情报收件箱人工复核'
            : article.cluster === 'failed'
              ? '点击重试聚类'
            : article.clusterRetryAt
              ? `聚类将于 ${new Date(article.clusterRetryAt).toLocaleString('zh-CN')} 后自动重试`
              : undefined}
        />
        <StepIndicator
          label="AI分析"
          status={aiLoading ? 'running' : article.ai}
          onClick={actionFor('ai')}
          forceLabel={nextAction?.step === 'ai' ? '重试' : undefined}
          title={article.ai === 'failed' ? '点击重试 AI 分析' : article.aiRetryAt ? `AI 将于 ${new Date(article.aiRetryAt).toLocaleString('zh-CN')} 后自动重试` : undefined}
        />
        <StepIndicator
          label="推送"
          status={pushLoading ? 'running' : article.push}
          onClick={actionFor('push')}
          forceLabel={nextAction?.step === 'push' ? (pushWaiting ? '等待' : '重试') : undefined}
          title={pushWaiting ? `推送将在 ${new Date(article.pushRetryAt!).toLocaleString('zh-CN')} 后自动重试` : article.push === 'failed' ? '点击重试投递' : undefined}
        />
      </div>
      {article.clusterStatus === 'needs_review' && <a href={`/admin?tab=articles&articleId=${encodeURIComponent(article.id)}&panel=cluster`} className="h-5 shrink-0 border px-1.5 text-[10px] hover:bg-muted">去聚类复核</a>}
      <a href={`/admin?tab=articles&articleId=${encodeURIComponent(article.id)}&panel=content`} className="h-5 shrink-0 border px-1.5 text-[10px] hover:bg-muted">查看内容</a>
      <span className="text-[11px] text-muted-foreground/50 shrink-0 tabular-nums w-14 text-right" title={article.lastTime ? new Date(article.lastTime).toLocaleString('zh-CN') : ''}>
        {article.lastTime ? (() => {
          const d = new Date(article.lastTime)
          const now = new Date()
          const isToday = d.toDateString() === now.toDateString()
          const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
          return isToday ? time : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`
        })() : ''}
      </span>
    </div>
  )
})
