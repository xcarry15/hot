'use client';

import { ChevronDown, FileText } from 'lucide-react';
import { SectionHeader } from './workspace-primitives';
import type { ArticleDetailDto } from '@/contracts/articles';
import { fullTimeLabel, pushStatusLabel } from './utils';

interface ArticleWorkspaceSupportPanelsProps {
  detail: ArticleDetailDto;
  cleanContentText: string;
  latestPushLogs: ArticleDetailDto['pushLogs'];
  showFullContent: boolean;
  onToggleFullContent: () => void;
}

export function ArticleWorkspaceSupportPanels({
  detail,
  cleanContentText,
  latestPushLogs,
  showFullContent,
  onToggleFullContent,
}: ArticleWorkspaceSupportPanelsProps) {
  return (
    <>
      <section className="bg-background">
        <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={onToggleFullContent}><span className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" aria-hidden="true" />正文核验 <span className="font-normal text-muted-foreground">{cleanContentText.length.toLocaleString('zh-CN')} 字</span></span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFullContent ? 'rotate-180' : ''}`} aria-hidden="true" /></button>
        {showFullContent && <div className="max-h-[42dvh] overflow-y-auto border-t border-border/60 px-3 py-2 text-[13px] leading-5 break-words whitespace-pre-line text-pretty sm:max-h-[120px] sm:text-xs">{cleanContentText.slice(0, 12000) || '正文尚未准备好'}</div>}
      </section>

      <section className="bg-background">
        <SectionHeader title="推送记录" meta={detail.pushLogs.length > 0 ? `${latestPushLogs.length} 个目标 · ${detail.pushLogs.length} 条记录` : undefined} />
        {detail.pushLogs.length > 0 ? <div className="divide-y divide-border/60">{detail.pushLogs.map((log) => <div key={log.id} className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[92px_minmax(0,1fr)_68px_116px] sm:items-center sm:gap-2"><span className={`font-medium ${log.status === 'success' ? 'text-emerald-700' : log.status === 'failed' || log.status === 'failure' ? 'text-red-700' : 'text-amber-700'}`}>{pushStatusLabel(log.status)}{log.retryCount > 0 ? ` · 重试 ${log.retryCount}` : ''}</span><span className="min-w-0 break-words sm:truncate" title={log.webhookTarget}>{log.webhookRemark || log.webhookTarget || '未命名目标'}</span><span className="text-muted-foreground">{log.articleId === detail.id ? '本篇代表' : '历史代表'}</span><span className="font-mono text-xs tabular-nums text-muted-foreground sm:text-right">{fullTimeLabel(log.createdAt)}</span>{log.errorMessage && <p className="text-red-700 sm:col-span-4">{log.errorMessage}</p>}</div>)}</div> : <p className="px-3 py-3 text-xs text-muted-foreground">暂无推送记录</p>}
      </section>
    </>
  );
}
