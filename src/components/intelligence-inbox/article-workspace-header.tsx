'use client';

import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ArticleDetailDto } from '@/contracts/articles';
import { isBusinessSkipReason } from '@/lib/article-pipeline-status';
import type { ManualOverrideField } from '@/lib/shared/article-calibration';
import type { WorkspaceStatusTone } from './types';
import { MetaRow, StatusPill } from './workspace-primitives';
import {
  fullTimeLabel,
  manualFieldLabel,
  processingLabel,
} from './utils';
import {
  WORKSPACE_ACTION_CLASS,
  WORKSPACE_SURFACE_CLASS,
} from './styles';

interface ArticleWorkspaceHeaderProps {
  detail: ArticleDetailDto;
  brands: string[];
  manualOverrides: ManualOverrideField[];
  clickRate: number;
  isRepresentative: boolean;
  currentConclusion: { label: string; tone: WorkspaceStatusTone };
  detailActionPending: boolean;
  editing: boolean;
  onToggleEditing: () => void;
}

export function ArticleWorkspaceHeader({
  detail,
  brands,
  manualOverrides,
  clickRate,
  isRepresentative,
  currentConclusion,
  detailActionPending,
  editing,
  onToggleEditing,
}: ArticleWorkspaceHeaderProps) {
  const processingState = processingLabel(detail);
  const processingFailed = detail.fetchStatus === 'failed'
    || detail.aiStatus === 'failed'
    || detail.clusterStatus === 'failed';
  const issueMessages = [
    detail.fetchError ? ['正文处理', detail.fetchError] : null,
    detail.aiError ? ['AI 分析', detail.aiError] : null,
    detail.clusterError ? ['事件聚类', detail.clusterError] : null,
    detail.skipReason
      ? [isBusinessSkipReason(detail.skipReason) ? '分析结果' : '跳过原因', detail.skipReason]
      : null,
  ].filter((item): item is [string, string] => item !== null);
  const hasProcessingError = Boolean(detail.fetchError || detail.aiError || detail.clusterError);

  return (
    <header className={WORKSPACE_SURFACE_CLASS}>
      <div className="min-w-0 px-2.5 py-2.5 pr-10 sm:px-3 sm:pr-11">
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-base font-semibold leading-6 sm:text-lg">
              {detail.title}
            </h1>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{detail.source.name}</span>
              <span>·</span>
              <time className="font-mono tabular-nums">
                {fullTimeLabel(detail.publishedAt ?? detail.createdAt)}
              </time>
              {processingState !== '正常' && (
                <StatusPill tone={processingFailed ? 'danger' : 'warning'}>
                  {processingState}
                </StatusPill>
              )}
              {isRepresentative && <StatusPill tone="accent">代表文章</StatusPill>}
              {detail.isAd && <StatusPill tone="danger">软文</StatusPill>}
              {detail.category && <StatusPill tone="neutral">{detail.category}</StatusPill>}
              {manualOverrides.length > 0 && (
                <StatusPill tone="neutral">人工修正 {manualOverrides.length} 项</StatusPill>
              )}
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <span className="text-muted-foreground">当前结论</span>
              <StatusPill tone={currentConclusion.tone}>{currentConclusion.label}</StatusPill>
            </div>
          </div>

          <div className="grid w-full shrink-0 grid-cols-2 gap-1 sm:flex sm:w-auto sm:flex-wrap">
            <a
              className={`inline-flex items-center justify-center gap-1 border bg-background hover:bg-muted ${WORKSPACE_ACTION_CLASS}`}
              href={detail.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-3 w-3" />查看原文
            </a>
            <Button
              size="sm"
              variant="outline"
              className={`${WORKSPACE_ACTION_CLASS} justify-center`}
              disabled={detailActionPending}
              onClick={onToggleEditing}
            >
              {editing ? '取消编辑' : '编辑文章'}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border/60 bg-muted/10 px-2.5 py-2 text-xs sm:px-3">
        <div className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
          <MetaRow label="品牌" value={brands.join('、') || '—'} />
          <MetaRow label="公开浏览" value={detail.viewCount.toLocaleString('zh-CN')} mono />
          <MetaRow
            label="原文点击"
            value={`${detail.originalClickCount.toLocaleString('zh-CN')} · ${clickRate}%`}
            mono
          />
          {detail.originalSource && detail.originalSource !== detail.source.name && (
            <MetaRow label="原始来源" value={detail.originalSource} />
          )}
          <MetaRow label="来源类型" value={detail.source.type} />
          <MetaRow label="人工修正" value={detail.manualCorrectedAt ? fullTimeLabel(detail.manualCorrectedAt) : '无'} />
          <div className="min-w-0 sm:col-span-2">
            <MetaRow label="事件键" value={detail.eventKey || '—'} mono />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground sm:gap-x-3">
          <span>创建 {fullTimeLabel(detail.createdAt)}</span>
          <span>更新 {fullTimeLabel(detail.updatedAt)}</span>
          <span>聚类 {fullTimeLabel(detail.clusteredAt)}</span>
        </div>

        <div className="grid min-w-0 gap-x-3 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
          <span className="min-w-0 break-all font-mono">ID {detail.id}</span>
          <a
            className="min-w-0 cursor-pointer break-all hover:text-foreground"
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            title={detail.url}
          >
            原始文章链接：{detail.url}
          </a>
        </div>

        {issueMessages.length > 0 && (
          <div className={`space-y-1 px-2 py-1.5 ${hasProcessingError ? 'bg-red-50/60 text-red-800' : 'bg-amber-50/70 text-amber-900'}`}>
            {issueMessages.map(([label, message]) => <p key={`${label}:${message}`}>{label}：{message}</p>)}
          </div>
        )}

        {manualOverrides.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted-foreground">人工覆盖</span>
            {manualOverrides.map((field) => (
              <Badge key={field} variant="secondary" className="h-5 rounded-none px-1 text-xs">
                {manualFieldLabel(field)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
