import { memo, useCallback } from 'react'
import { formatPubDate } from './helpers'
import { StepIndicator, SkipBadge } from './step-indicator'
import { ScoreBadge } from '@/components/ui/score-badge'
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
  onStepAction?: (articleId: string, step: 'process' | 'ai' | 'push', options?: { force?: boolean }) => void
  onStepActionLoading?: (articleId: string, step: 'process' | 'ai' | 'push') => boolean
  onOpenArticle?: (articleId: string) => void
  /** P1-1: 批量 Job 运行时，单篇动作禁用，避免并发冲突 */
  isJobRunning?: boolean
}) {
  const isSkipped = article.crawl === 'skipped'
  const pubDate = formatPubDate(article.publishedAt)

  // 从 skipReason 中提取被匹配的文章标题
  // 格式: "[重复] 与 \"xxx\" 报道同一事件" 或 "与 \"xxx\" 正文数值重叠"
  const matchedTitle = (() => {
    if (!article.skipReason) return undefined
    const m = article.skipReason.match(/与\s*"([^"]+)"/)
    return m ? m[1] : undefined
  })()

  const handleProcess = useCallback(() => {
    onStepAction?.(article.id, 'process')
  }, [onStepAction, article.id])

  const handleAi = useCallback(() => {
    onStepAction?.(article.id, 'ai')
  }, [onStepAction, article.id])

  const handlePush = useCallback(() => {
    onStepAction?.(article.id, 'push', { force: article.push === 'filtered' || article.push === 'done' })
  }, [onStepAction, article.id, article.push])

  const handleOpen = useCallback(() => {
    onOpenArticle?.(article.id)
  }, [onOpenArticle, article.id])

  const processLoading = onStepActionLoading?.(article.id, 'process') ?? false
  const aiLoading = onStepActionLoading?.(article.id, 'ai') ?? false
  const pushLoading = onStepActionLoading?.(article.id, 'push') ?? false

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
      {typeof article.aiScore === 'number' && article.aiScore > 0 && (
        <ScoreBadge
          score={article.aiScore}
          variant="compact"
          details={{
            eventScore: article.eventScore,
            contentScore: article.contentScore,
            rawScore: article.rawScore,
            adProbability: article.adProbability,
            aiConfidence: article.aiConfidence,
          }}
        />
      )}
      {article.isAd && (
        <span className="text-[10px] px-1 py-0 rounded-full bg-red-100 text-red-700 shrink-0 leading-5">软文</span>
      )}
      {article.skipReason?.startsWith('[重复]') && (
        <span className="text-[10px] px-1 py-0 rounded-full bg-red-100 text-red-700 shrink-0 leading-5">重复</span>
      )}
      <button
        className="truncate min-w-0 flex-1 text-muted-foreground group-hover:text-foreground text-left"
        title={article.title}
        onClick={handleOpen}
      >
        {article.title}
      </button>
      {matchedTitle && (
        <span className="text-xs text-red-500 shrink-0 truncate max-w-[200px]" title={`匹配: ${matchedTitle}`}>
          ←{matchedTitle}
        </span>
      )}
      {(isSkipped || article.ai === 'skipped') && article.skipReason && (
        <SkipBadge reason={article.skipReason} />
      )}
      <div className="flex items-center gap-0.5 shrink-0 group-hover:ring-1 group-hover:ring-blue-300 group-hover:ring-offset-1">
        <StepIndicator label="采集" status={article.crawl} />
        <StepIndicator
          label="处理"
          status={processLoading ? 'running' : article.process}
          onClick={!isJobRunning && !processLoading && (article.process === 'pending' || article.process === 'failed' || article.process === 'done') ? handleProcess : undefined}
        />
        <StepIndicator
          label="AI分析"
          status={aiLoading ? 'running' : article.ai}
          onClick={!isJobRunning && !aiLoading && (article.ai === 'pending' || article.ai === 'failed' || article.ai === 'skipped' || article.ai === 'done') ? handleAi : undefined}
          title={article.aiRetryAt ? `AI 将于 ${new Date(article.aiRetryAt).toLocaleString('zh-CN')} 后自动重试` : undefined}
        />
        <StepIndicator
          label="推送"
          status={pushLoading ? 'running' : article.push}
          onClick={!isJobRunning && !pushLoading && (article.push === 'pending' || article.push === 'failed' || article.push === 'filtered' || article.push === 'done') ? handlePush : undefined}
          forceLabel={article.push === 'filtered' ? '强制推送' : article.push === 'done' ? '重新推送' : undefined}
          title={article.pushRetryAt ? `推送将在 ${new Date(article.pushRetryAt).toLocaleString('zh-CN')} 后自动重试` : undefined}
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
