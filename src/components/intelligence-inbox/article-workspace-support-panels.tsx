'use client';

import { memo } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import type { ArticleDetailDto } from '@/contracts/articles';
import { SectionHeader } from './workspace-primitives';
import { fullTimeLabel, pushStatusLabel } from './utils';
import { WORKSPACE_SURFACE_CLASS } from './styles';

interface ArticleWorkspaceSupportPanelsProps {
  detail: ArticleDetailDto;
  cleanContentText: string;
  latestPushLogs: ArticleDetailDto['pushLogs'];
  showFullContent: boolean;
  onToggleFullContent: () => void;
}

export const ArticleWorkspaceSupportPanels = memo(function ArticleWorkspaceSupportPanels({
  detail,
  cleanContentText,
  latestPushLogs,
  showFullContent,
  onToggleFullContent,
}: ArticleWorkspaceSupportPanelsProps) {
  const pushLogCount = detail.pushLogs.length;

  return (
    <>
      <section className={WORKSPACE_SURFACE_CLASS}>
        <button
          type="button"
          aria-expanded={showFullContent}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
          onClick={onToggleFullContent}
        >
          <span className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            正文核验
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${showFullContent ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        {showFullContent && (
          <div className="max-h-[42dvh] overflow-y-auto border-t border-border/60 px-3 py-2 text-[13px] leading-5 break-words whitespace-pre-line text-pretty sm:max-h-[120px] sm:text-xs">
            {cleanContentText.slice(0, 12000) || '正文尚未准备好'}
          </div>
        )}
      </section>

      <section className={WORKSPACE_SURFACE_CLASS}>
        <SectionHeader
          title="推送记录"
          meta={pushLogCount > 0 ? `${latestPushLogs.length} 个目标 · ${pushLogCount} 条记录` : undefined}
        />
        {pushLogCount > 0 ? (
          <div className="divide-y divide-border/60">
            {detail.pushLogs.map((log) => <PushLogRow key={log.id} detailId={detail.id} log={log} />)}
          </div>
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground">暂无推送记录</p>
        )}
      </section>
    </>
  );
});

function PushLogRow({
  detailId,
  log,
}: {
  detailId: string;
  log: ArticleDetailDto['pushLogs'][number];
}) {
  const statusClass = log.status === 'success'
    ? 'text-emerald-700'
    : log.status === 'failed' || log.status === 'failure'
      ? 'text-red-700'
      : 'text-amber-700';

  return (
    <div className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[92px_minmax(0,1fr)_68px_116px] sm:items-center sm:gap-2">
      <span className={`font-medium ${statusClass}`}>
        {pushStatusLabel(log.status)}{log.retryCount > 0 ? ` · 重试 ${log.retryCount}` : ''}
      </span>
      <span className="min-w-0 break-words sm:truncate" title={log.webhookTarget}>
        {log.webhookRemark || log.webhookTarget || '未命名目标'}
      </span>
      <span className="text-muted-foreground">{log.articleId === detailId ? '本篇代表' : '历史代表'}</span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">
        {fullTimeLabel(log.createdAt)}
      </span>
      {log.errorMessage && <p className="text-red-700 sm:col-span-4">{log.errorMessage}</p>}
    </div>
  );
}
