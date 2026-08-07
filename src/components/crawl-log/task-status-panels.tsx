'use client'

import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Check, Loader2, XCircle } from 'lucide-react'

type ActiveTaskView = {
  taskLabel: string
  targetLabel: string | null
  currentPosition: number
  stages: Array<{
    key: string
    label: string
    state: 'done' | 'running' | 'pending'
    progress: { done: number; total: number } | null
  }>
}

type ProgressView = {
  isRunning: boolean
  pct: number | null
  errors: number
  stageLabel: string
}

interface TaskStatusPanelsProps {
  activeTaskView: ActiveTaskView | null
  progressView: ProgressView | null
  latestJobFailure: string | null
  failedSourcesCount: number
  failedArticles: number
  autoRetryArticles: number
  isOperationBusy: boolean
  onRetryFailedSources: () => void
}

const TASK_STAGE_CLASS = 'inline-flex h-6 items-center gap-1 border px-2 text-[11px]'

export const TaskStatusPanels = memo(function TaskStatusPanels({
  activeTaskView,
  progressView,
  latestJobFailure,
  failedSourcesCount,
  failedArticles,
  autoRetryArticles,
  isOperationBusy,
  onRetryFailedSources,
}: TaskStatusPanelsProps) {
  const hasFailures = failedSourcesCount > 0 || failedArticles > 0 || autoRetryArticles > 0

  return (
    <>
      {activeTaskView && progressView?.isRunning && (
        <div className="space-y-2 border bg-background px-3 py-2" aria-label="当前任务进度">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-medium">当前任务</span>
            <Badge variant="outline" className="h-5 rounded-none px-1.5 text-[10px]">
              {activeTaskView.taskLabel}
            </Badge>
            {activeTaskView.targetLabel && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={activeTaskView.targetLabel}>
                {activeTaskView.targetLabel}
              </span>
            )}
            {activeTaskView.currentPosition > 0 && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                阶段 {activeTaskView.currentPosition}/{activeTaskView.stages.length}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5 overscroll-contain">
            {activeTaskView.stages.map((stage, index) => (
              <div key={stage.key} className="flex shrink-0 items-center gap-1">
                {index > 0 && <span className="h-px w-3 bg-border" />}
                <span
                  className={`${TASK_STAGE_CLASS} ${stage.state === 'done'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : stage.state === 'running'
                      ? 'border-blue-300 bg-blue-50 font-medium text-blue-700'
                      : 'border-border bg-muted/30 text-muted-foreground'}`}
                  aria-current={stage.state === 'running' ? 'step' : undefined}
                >
                  {stage.state === 'done' ? (
                    <Check className="h-3 w-3" />
                  ) : stage.state === 'running' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />
                  )}
                  {stage.label}
                  {stage.progress && stage.progress.total > 0 && (
                    <span className="ml-0.5 tabular-nums opacity-75">
                      {stage.progress.done}/{stage.progress.total}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            {progressView.pct != null && (
              <span className="w-9 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                {progressView.pct}%
              </span>
            )}
            <div className="h-1.5 flex-1 overflow-hidden rounded-none bg-muted">
              <div
                className={`h-full rounded-none bg-primary transition-[width] duration-300 ease-out ${progressView.pct == null ? 'w-1/3 animate-pulse' : ''}`}
                style={progressView.pct == null ? undefined : { width: `${progressView.pct}%` }}
                role="progressbar"
                aria-valuenow={progressView.pct ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="当前阶段进度"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs">
              <span className="font-medium text-blue-700">{progressView.stageLabel || '准备中'}</span>
              {progressView.errors > 0 && <span className="font-medium text-destructive">✕{progressView.errors}</span>}
            </div>
          </div>
        </div>
      )}

      {latestJobFailure && (
        <div className="flex min-w-0 items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 font-medium">任务失败</span>
          <span className="min-w-0 break-words text-destructive/90">{latestJobFailure}</span>
        </div>
      )}

      {hasFailures && (
        <div className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">异常摘要</span>
          {failedSourcesCount > 0 && <span>{failedSourcesCount} 个数据源失败</span>}
          {autoRetryArticles > 0 && <span>自动恢复中 {autoRetryArticles} 篇</span>}
          {failedArticles > 0 && <span>需人工处理 {failedArticles} 篇；当前列表已包含全部技术待办</span>}
          {failedSourcesCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 border-amber-300 px-2 text-xs text-amber-900"
              disabled={isOperationBusy}
              onClick={() => void onRetryFailedSources()}
            >
              一键重试异常源
            </Button>
          )}
        </div>
      )}
    </>
  )
})
