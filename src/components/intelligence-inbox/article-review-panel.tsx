'use client';

import { Loader2, RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScoreBadge } from '@/components/ui/score-badge';
import { Textarea } from '@/components/ui/textarea';
import type { ArticleDetailDto } from '@/contracts/articles';
import type { ArticleEditorialDraft, PushTargetSummary } from './types';
import { InlineMetric, StatusPill } from './workspace-primitives';
import {
  EDITOR_FIELD_CLASS,
  processingLabel,
  publicResultLabel,
} from './utils';

interface ArticleReviewPanelProps {
  detail: ArticleDetailDto;
  keyPoints: string[];
  releaseStatus: string;
  pushSummary: PushTargetSummary;
  releaseGateMessage: string;
  isRepresentative: boolean;
  canForcePush: boolean;
  eventPushedAt: string | null | undefined;
  rowSaving: boolean;
  eventActionPending: boolean;
  detailAction: 'edit' | 'workflow' | null;
  editing: boolean;
  draft: ArticleEditorialDraft;
  onChangePublicOverride: (next: 'auto' | 'public' | 'hidden') => void;
  onPushEvent: (mode: 'manual' | 'repush') => void;
  onStartWorkflow: (startAt: 'process' | 'ai') => void;
  onDraftChange: (patch: Partial<ArticleEditorialDraft>) => void;
  onSaveEditorial: () => void;
}

export function ArticleReviewPanel({
  detail,
  keyPoints,
  releaseStatus,
  pushSummary,
  releaseGateMessage,
  isRepresentative,
  canForcePush,
  eventPushedAt,
  rowSaving,
  eventActionPending,
  detailAction,
  editing,
  draft,
  onChangePublicOverride,
  onPushEvent,
  onStartWorkflow,
  onDraftChange,
  onSaveEditorial,
}: ArticleReviewPanelProps) {
  return (
    <>
      <section className="min-w-0 bg-background">
        <div className="grid min-w-0 md:grid-cols-2 md:items-stretch">
          <div className="min-w-0 px-3 py-2.5 md:max-h-[220px] md:overflow-y-auto">
            <h2 className="mb-1.5 text-xs font-semibold">核心要点</h2>
            {keyPoints.length > 0 ? (
              <ol className="space-y-1 text-[13px] leading-5">
                {keyPoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-1.5">
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                    <span className="min-w-0 break-words">{point}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-[13px] leading-5 text-muted-foreground">暂无核心要点。</p>}
          </div>

          <div className="min-w-0 border-t border-border/50 bg-muted/15 px-3 py-2.5 md:max-h-[220px] md:overflow-y-auto md:border-l md:border-t-0">
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold">AI洞察</h2>
              <span className={`text-[11px] ${detail.aiStatus === 'done' ? 'text-emerald-700' : 'text-muted-foreground'}`}>{detail.aiStatus === 'done' ? '分析完成' : processingLabel(detail)}</span>
              <Button size="sm" variant="ghost" className="ml-auto h-6 rounded-none px-1.5 text-[11px]" disabled={detailAction !== null} onClick={() => onStartWorkflow('ai')}><RefreshCw className="h-3 w-3" />重新生成</Button>
            </div>
            <p className="break-words whitespace-pre-line text-[13px] leading-5 text-foreground/85">{detail.summary.trim() || detail.excerpt.trim() || '暂无 AI 洞察。'}</p>
          </div>
        </div>

        <div className="min-w-0 border-t border-border/60 bg-muted/10 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-xs font-semibold">审核与发布</h2>
            <StatusPill tone={releaseStatus === 'published' ? 'success' : detail.publicOverride === 'hidden' ? 'neutral' : 'warning'}>事件公开：{publicResultLabel({ publicStatus: releaseStatus })}</StatusPill>
            <StatusPill tone={pushSummary.tone}>推送：{pushSummary.label}</StatusPill>
            <span className="min-w-0 basis-full break-words text-[11px] text-muted-foreground sm:basis-auto">文章覆盖：{detail.publicOverride === 'auto' ? '自动公开' : detail.publicOverride === 'public' ? '强制公开' : '人工隐藏'} · 公开门禁：{releaseGateMessage}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className="text-muted-foreground">综合</span><ScoreBadge score={detail.score} variant="compact-square" /></span>
            <InlineMetric label="内容" value={detail.contentScore} />
            <InlineMetric label="事件" value={detail.eventScore} />
            <InlineMetric label="相关" value={detail.relevance} />
            <InlineMetric label="AI 分析置信度" value={detail.aiConfidence} suffix="%" />
            <InlineMetric label="广告" value={detail.adProbability} suffix="%" danger={detail.isAd} />
            <InlineMetric label="事件身份置信度" value={detail.eventKeyConfidence} suffix="%" />
            <InlineMetric label="原始评分" value={detail.rawScore} />
          </div>
          {!isRepresentative && <p className="mt-1 text-[11px] leading-4 text-amber-700">本篇非代表文章，公开与推送由事件代表文章决定。</p>}
          <div className="mt-1.5 grid grid-cols-2 gap-1 sm:flex sm:flex-wrap">
            <Button size="sm" variant="ghost" aria-pressed={detail.publicOverride === 'auto'} className={`h-7 rounded-none px-2 text-xs ${detail.publicOverride === 'auto' ? 'bg-sky-50 text-sky-800 hover:bg-sky-50' : ''}`} disabled={rowSaving} onClick={() => onChangePublicOverride('auto')}>自动公开</Button>
            <Button size="sm" variant="ghost" aria-pressed={detail.publicOverride === 'public'} className={`h-7 rounded-none px-2 text-xs ${detail.publicOverride === 'public' ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-50' : ''}`} disabled={rowSaving} onClick={() => onChangePublicOverride('public')}>强制公开</Button>
            <Button size="sm" variant="ghost" aria-pressed={detail.publicOverride === 'hidden'} className={`h-7 rounded-none px-2 text-xs ${detail.publicOverride === 'hidden' ? 'bg-red-50 text-red-700 hover:bg-red-50' : ''}`} disabled={rowSaving} onClick={() => onChangePublicOverride('hidden')}>隐藏文章</Button>
            {canForcePush && <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" disabled={eventActionPending} onClick={() => onPushEvent(eventPushedAt ? 'repush' : 'manual')}>{eventPushedAt ? '再次推送' : '强制推送'}</Button>}
            <Button size="sm" variant="ghost" className="col-span-2 h-7 rounded-none px-2 text-xs sm:col-span-1" disabled={detailAction !== null} onClick={() => onStartWorkflow('process')}>全量重跑</Button>
          </div>
        </div>
      </section>

      {editing && <section className="grid gap-2 border-l-2 border-amber-400 bg-amber-50/20 p-3 sm:grid-cols-2"><p className="text-[11px] leading-4 text-amber-900 sm:col-span-2">编辑影响：保存事件身份会重新计算事件归属；内容或品牌变化可能重新计算公开资格。公开和推送结果以事件状态及代表文章为准。</p><label className="space-y-1 text-xs">品牌<Input className={`h-8 ${EDITOR_FIELD_CLASS}`} value={draft.brand} onChange={(event) => onDraftChange({ brand: event.target.value })} /></label><label className="space-y-1 text-xs">分类<Input className={`h-8 ${EDITOR_FIELD_CLASS}`} value={draft.category} onChange={(event) => onDraftChange({ category: event.target.value })} /></label><label className="space-y-1 text-xs">事件主体（多个主体用逗号分隔）<Input className={`h-8 ${EDITOR_FIELD_CLASS}`} value={draft.eventSubjects} onChange={(event) => onDraftChange({ eventSubjects: event.target.value })} /></label><label className="space-y-1 text-xs">事件行为（保留计划/正式/完成等阶段）<Input className={`h-8 ${EDITOR_FIELD_CLASS}`} value={draft.eventAction} onChange={(event) => onDraftChange({ eventAction: event.target.value })} /></label><label className="space-y-1 text-xs sm:col-span-2">具体事项<Input className={`h-8 ${EDITOR_FIELD_CLASS}`} value={draft.eventObject} onChange={(event) => onDraftChange({ eventObject: event.target.value })} /></label><label className="space-y-1 text-xs sm:col-span-2">AI洞察<Textarea value={draft.summary} onChange={(event) => onDraftChange({ summary: event.target.value })} className={`min-h-24 ${EDITOR_FIELD_CLASS}`} /></label><label className="space-y-1 text-xs sm:col-span-2">核心要点（每行一条）<Textarea value={draft.keyPoints} onChange={(event) => onDraftChange({ keyPoints: event.target.value })} className={`min-h-24 ${EDITOR_FIELD_CLASS}`} /></label><Button size="sm" className="h-8 rounded-none text-xs sm:col-span-2" disabled={detailAction !== null} onClick={onSaveEditorial}>{detailAction === 'edit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存人工修正</Button></section>}
    </>
  );
}
