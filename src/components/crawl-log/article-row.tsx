import { memo, useCallback, useMemo } from 'react'
import { ScoreBadge } from '@/components/ui/score-badge'
import { cancelArticleDetailPrefetch, prefetchArticleDetail } from '@/features/articles-api.client'
import { formatPubDate } from './helpers'
import { StepIndicator, SkipBadge } from './step-indicator'
import type { ArticleProgress } from './types'
import type { ArticleWorkspacePanel } from '@/components/article-workspace'
import { preloadArticleWorkspace } from '@/components/article-workspace-drawer'
import { isBusinessSkipReason } from '@/lib/article-pipeline-status'

// ========== Article Row ==========

export const ArticleRow = memo(function ArticleRow({
  article,
  onStepAction,
  onStepActionLoading,
  onTechnicalStatus,
  onOpenArticle,
  onOpenArticlePanel,
  isJobRunning,
}: {
  article: ArticleProgress
  onStepAction?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => void
  onStepActionLoading?: (articleId: string, step: 'process' | 'cluster' | 'ai' | 'push') => boolean
  onTechnicalStatus?: (articleId: string, action: 'ignore' | 'restore') => void
  onOpenArticle?: (articleId: string) => void
  onOpenArticlePanel?: (articleId: string, panel: ArticleWorkspacePanel) => void
  /** 批量 Job 运行时禁用单篇动作，避免并发冲突。 */
  isJobRunning?: boolean
}) {
  const isSkipped = article.crawl === 'skipped'
  const pubDate = formatPubDate(article.publishedAt)


  const nextAction = useMemo(() => article.process === 'failed'
    ? { step: 'process' as const, label: '重试处理' }
    : article.ai === 'failed' || (article.ai === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))
      ? { step: 'ai' as const, label: '重试 AI' }
      : article.cluster === 'failed'
        ? { step: 'cluster' as const, label: '重试聚类' }
        : article.push === 'failed'
          ? { step: 'push' as const, label: article.pushRetryAt && new Date(article.pushRetryAt) > new Date() ? '等待重试' : '重试投递' }
          : null, [article.ai, article.cluster, article.process, article.push, article.pushRetryAt, article.skipReason])

  const handleNextAction = useCallback(() => {
    if (!nextAction) return
    onStepAction?.(article.id, nextAction.step)
  }, [article.id, nextAction, onStepAction])

  const handleOpen = useCallback(() => {
    onOpenArticle?.(article.id)
  }, [onOpenArticle, article.id])

  const handlePrefetch = useCallback(() => {
    preloadArticleWorkspace()
    prefetchArticleDetail(article.id)
  }, [article.id])

  const processLoading = onStepActionLoading?.(article.id, 'process') ?? false
  const clusterLoading = onStepActionLoading?.(article.id, 'cluster') ?? false
  const aiLoading = onStepActionLoading?.(article.id, 'ai') ?? false
  const pushLoading = onStepActionLoading?.(article.id, 'push') ?? false
  const businessAiSkipped = article.ai === 'skipped' && isBusinessSkipReason(article.skipReason)
  const businessAiSkipLabel = article.skipReason === '无具体事件' ? '无具体事件' : '多事件聚合稿'
  const nextActionLoading = nextAction?.step === 'process'
    ? processLoading
    : nextAction?.step === 'cluster'
      ? clusterLoading
      : nextAction?.step === 'ai'
        ? aiLoading
        : nextAction?.step === 'push'
          ? pushLoading
          : false
  const retryAt = nextAction?.step === 'process' ? article.processRetryAt
    : nextAction?.step === 'cluster' ? article.clusterRetryAt
      : nextAction?.step === 'ai' ? article.aiRetryAt
        : nextAction?.step === 'push' ? article.pushRetryAt : null
  const retryWaiting = article.technicalState === 'auto_retry' && Boolean(retryAt && new Date(retryAt) > new Date())
  const pushResultUnknown = nextAction?.step === 'push' && article.technicalErrorReasons.push?.includes('结果未知')
  const canRunNextAction = Boolean(nextAction) && !isJobRunning && !nextActionLoading && !retryWaiting && !pushResultUnknown
  const actionFor = (step: 'process' | 'cluster' | 'ai' | 'push') =>
    nextAction?.step === step && canRunNextAction ? handleNextAction : undefined
  const technicalReason = nextAction ? article.technicalErrorReasons[nextAction.step] : undefined
  const isUnknownPushResult = article.technicalErrorReasons.push?.includes('投递结果未知') ?? false

  return (
    <div className={`group flex min-h-6 items-center gap-1 border-l-2 border-l-transparent px-2 py-0.5 text-[12px] leading-5 overflow-hidden whitespace-nowrap transition-colors hover:border-l-blue-500 hover:bg-blue-100/80 hover:shadow-[inset_0_1px_0_rgba(59,130,246,0.12),inset_0_-1px_0_rgba(59,130,246,0.12)] ${
      isSkipped || article.technicalState === 'ignored' ? 'opacity-50' : ''
    }`}>
      {pubDate && (
        <span
          className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums font-mono"
          title={article.publishedAt || ''}
        >
          {pubDate}
        </span>
      )}
      {(article.ai === 'done' || businessAiSkipped) && article.score != null && (
        <span aria-label={`评分 ${article.score} 分`} title={`AI 分析完成${businessAiSkipped ? `，${businessAiSkipLabel}` : ''}，最终评分 ${article.score} 分`}>
          <ScoreBadge score={article.score} variant="compact-square" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground text-left"
          title={article.title}
          onClick={handleOpen}
          onMouseEnter={handlePrefetch}
          onMouseLeave={() => cancelArticleDetailPrefetch(article.id)}
          onFocus={handlePrefetch}
        >
          {article.title}
        </button>
        {article.anomalyLabels?.includes('ad') && (
          <span className="shrink-0 bg-slate-500 px-1 text-[11px] font-medium leading-5 text-white" title="业务识别：AI 判定为广告或软文">软文</span>
        )}
        {article.anomalyLabels?.includes('duplicate') && (
          <span className="shrink-0 bg-amber-500 px-1 text-[11px] font-medium leading-5 text-white" title="业务识别：已归入同一事件，非当前代表文章">重复</span>
        )}
        {article.anomalyLabels?.includes('low-confidence') && (
          <span className="shrink-0 bg-violet-600 px-1 text-[11px] font-medium leading-5 text-white" title="AI 对文章分析结论的证据把握不足">低分析置信</span>
        )}
        {article.clusterStatus === 'needs_review' && (
          <>
            <span className="shrink-0 bg-orange-500 px-1 text-[11px] font-medium leading-5 text-white">待复核</span>
            <button type="button" onClick={() => onOpenArticlePanel?.(article.id, 'cluster')} className="inline-flex h-5 shrink-0 items-center justify-center border border-black bg-background px-1.5 text-[11px] font-medium leading-5 text-foreground hover:bg-muted">去聚类复核</button>
          </>
        )}
        {article.technicalState === 'auto_retry' && (
          <>
            <span className="shrink-0 bg-red-600 px-1 text-[11px] font-medium leading-5 text-white" title="流程失败，正在自动恢复">异常</span>
            {retryAt && <span className="shrink-0 bg-blue-600 px-1 text-[11px] font-medium leading-5 text-white" title={`将在 ${new Date(retryAt).toLocaleString('zh-CN')} 自动重试`}>自动恢复中</span>}
            <button type="button" onClick={() => onTechnicalStatus?.(article.id, 'ignore')} disabled={isJobRunning} className="inline-flex h-5 shrink-0 items-center justify-center border border-black bg-background px-1.5 text-[11px] font-medium leading-5 text-foreground hover:bg-muted" title="立即停止后续自动重试并忽略">强制忽略</button>
          </>
        )}
        {article.technicalState === 'manual' && (
          <>
            <span className="shrink-0 bg-red-600 px-1 text-[11px] font-medium leading-5 text-white">需人工处理</span>
            <button type="button" onClick={() => onTechnicalStatus?.(article.id, 'ignore')} disabled={isJobRunning} className="inline-flex h-5 shrink-0 items-center justify-center border border-black bg-background px-1.5 text-[11px] font-medium leading-5 text-foreground hover:bg-muted" title="从技术待办中忽略">忽略</button>
          </>
        )}
        {technicalReason && article.technicalState !== 'ignored' && (
          <span className="max-w-[220px] shrink-0 truncate text-[11px] text-destructive" title={technicalReason}>原因：{technicalReason}</span>
        )}
        {isUnknownPushResult && article.technicalState !== 'ignored' && (
          <button
            type="button"
            onClick={() => onOpenArticle?.(article.id)}
            className="inline-flex h-5 shrink-0 items-center justify-center border border-amber-500 bg-background px-1.5 text-[11px] font-medium leading-5 text-amber-800 hover:bg-amber-50"
            title="结果未知不能自动重试；请在文章工作台确认后使用 Event 强制推送"
          >
            去确认推送
          </button>
        )}
        {article.technicalState === 'ignored' && (
          <>
            <span className="shrink-0 bg-zinc-500 px-1 text-[11px] font-medium leading-5 text-white">已忽略</span>
            <button type="button" onClick={() => onTechnicalStatus?.(article.id, 'restore')} disabled={isJobRunning} className="inline-flex h-5 shrink-0 items-center justify-center border border-black bg-background px-1.5 text-[11px] font-medium leading-5 text-foreground hover:bg-muted">恢复</button>
          </>
        )}
        {(isSkipped || article.ai === 'skipped') && article.skipReason && (
          <SkipBadge reason={article.skipReason} />
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0 group-hover:ring-1 group-hover:ring-blue-300 group-hover:ring-offset-1">
        <StepIndicator label="采集" status={article.crawl} />
        <StepIndicator
          label="处理"
          status={processLoading ? 'running' : article.process}
          onClick={actionFor('process')}
          forceLabel={nextAction?.step === 'process' ? (retryWaiting ? '等待' : '重试') : undefined}
          title={retryWaiting && article.processRetryAt ? `处理将在 ${new Date(article.processRetryAt).toLocaleString('zh-CN')} 自动重试` : article.technicalErrorReasons.process || (article.process === 'failed' ? '点击重试处理' : undefined)}
        />
        <StepIndicator
          label="AI分析"
          status={aiLoading ? 'running' : businessAiSkipped ? 'done' : article.ai}
          onClick={actionFor('ai')}
          forceLabel={nextAction?.step === 'ai' ? (retryWaiting ? '等待' : '重试') : undefined}
          title={businessAiSkipped
            ? `AI 分析已完成，但文章${article.skipReason === '无具体事件' ? '没有具体事件' : '属于多事件聚合稿'}`
            : article.technicalErrorReasons.ai || (article.ai === 'failed' ? '点击重试 AI 分析' : article.aiRetryAt ? `AI 将于 ${new Date(article.aiRetryAt).toLocaleString('zh-CN')} 后自动重试` : undefined)}
        />
        <StepIndicator
          label="聚类"
          status={clusterLoading ? 'running' : article.cluster}
          onClick={actionFor('cluster')}
          forceLabel={nextAction?.step === 'cluster' ? (retryWaiting ? '等待' : '重试') : undefined}
          title={article.clusterStatus === 'needs_review'
            ? '聚类结果存在歧义，点击打开文章工作台复核'
            : article.technicalErrorReasons.cluster || (article.cluster === 'failed'
              ? '点击重试聚类'
              : article.clusterRetryAt
                ? `聚类将于 ${new Date(article.clusterRetryAt).toLocaleString('zh-CN')} 后自动重试`
                : undefined)}
        />
        <StepIndicator
          label="公开"
          status={article.isPublic ? 'done' : 'not_applicable'}
          title={article.isPublic ? '当前 Event 代表文章已在公开端展示' : '当前文章未在公开端展示'}
        />
        <StepIndicator
          label="推送"
          status={pushLoading ? 'running' : article.push}
          onClick={actionFor('push')}
          forceLabel={nextAction?.step === 'push' && !pushResultUnknown ? (retryWaiting ? '等待' : '重试') : undefined}
          title={retryWaiting && article.pushRetryAt ? `推送将在 ${new Date(article.pushRetryAt).toLocaleString('zh-CN')} 自动重试` : article.technicalErrorReasons.push || (article.push === 'failed' ? '点击重试投递' : undefined)}
        />
      </div>
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
