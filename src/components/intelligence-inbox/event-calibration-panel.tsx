'use client';

import { memo } from 'react';
import { Merge, RefreshCw, Search, Split } from 'lucide-react';
import { EventArticleList, type EventArticleRowModel } from '@/components/article-workspace/event-article-list';
import { ScoreBadge } from '@/components/ui/score-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ArticleDetailDto } from '@/contracts/articles';
import { splitBrands } from '@/lib/shared/article-codecs';
import type { EventAudit, EventDetail, EventOption } from './types';
import {
  EmptyEventTab,
  EventCalibrationGroup,
  SectionHeader,
  StatusPill,
  eventReviewStatusLabel,
  eventStatusLabel,
} from './workspace-primitives';
import {
  clusterAuditActionLabel,
  clusterAuditDecisionSourceLabel,
  clusterAuditEvidenceLabels,
  clusterAuditOutcome,
  fullTimeLabel,
  timeLabel,
} from './utils';
import {
  WORKSPACE_BUTTON_CLASS,
  WORKSPACE_INPUT_CLASS,
  WORKSPACE_KEYWORD_CLASS,
  WORKSPACE_SECTION_CLASS,
  WORKSPACE_SURFACE_CLASS,
} from './styles';

interface EventCalibrationPanelProps {
  detail: ArticleDetailDto;
  eventDetail: EventDetail | null;
  eventSourceCount: number;
  eventMemberModels: EventArticleRowModel[];
  recommendedEventModels: EventArticleRowModel[];
  brandCandidateModels: EventArticleRowModel[];
  currentArticleClassificationAudit: EventAudit | null;
  eventArticleTitles: Map<string, string>;
  selectedSplitIds: ReadonlySet<string>;
  eventActionPending: boolean;
  eventSearch: string;
  eventOptions: EventOption[];
  mergeTargetId: string;
  onConfirmIndependent: () => void;
  onAutoCluster: () => void;
  onSplitArticles: (articleIds: string[]) => void;
  onEventSearchChange: (value: string) => void;
  onSearchEvents: (query?: string) => void;
  onMoveCurrentArticle: (eventId: string) => void;
  onMergeTargetChange: (eventId: string) => void;
  onMergeCurrentEvent: () => void;
}

export const EventCalibrationPanel = memo(function EventCalibrationPanel({
  detail,
  eventDetail,
  eventSourceCount,
  eventMemberModels,
  recommendedEventModels,
  brandCandidateModels,
  currentArticleClassificationAudit,
  eventArticleTitles,
  selectedSplitIds,
  eventActionPending,
  eventSearch,
  eventOptions,
  mergeTargetId,
  onConfirmIndependent,
  onAutoCluster,
  onSplitArticles,
  onEventSearchChange,
  onSearchEvents,
  onMoveCurrentArticle,
  onMergeTargetChange,
  onMergeCurrentEvent,
}: EventCalibrationPanelProps) {
  if (!eventDetail) {
    const canAutoCluster = detail.fetchStatus === 'fetched' && detail.aiStatus === 'done';
    return (
      <section className={WORKSPACE_SURFACE_CLASS}>
        <SectionHeader title="事件校准" meta="尚未归入 Event" />
        <div className="space-y-1.5 border-l-2 border-sky-400 bg-sky-50 px-3 py-2.5">
          <p className="text-xs leading-5 text-sky-950">
            当前文章尚未归入事件。完成正文和 AI 分析后，系统会按分析结果自动建立独立 Event。
          </p>
          <Button
            size="sm"
            className={WORKSPACE_BUTTON_CLASS}
            disabled={eventActionPending || !canAutoCluster}
            onClick={onAutoCluster}
          >
            <RefreshCw className="h-3 w-3" />自动建立独立事件
          </Button>
        </div>
      </section>
    );
  }

  const currentEventAudits = eventDetail.audits;
  const eventBrands = Array.from(new Set(eventDetail.articles.flatMap((article) => splitBrands(article.brand))));
  const eventKey = detail.eventKey.trim() || eventDetail.articles.find((article) => article.eventKey.trim())?.eventKey.trim() || '';
  const eventKeyKeywords = Array.from(new Set(eventKey.split(/[+/]/u).map((keyword) => keyword.trim()).filter(Boolean)));

  const searchEventKeyword = (keyword: string) => {
    const query = keyword.trim();
    if (!query) return;
    onEventSearchChange(query);
    onSearchEvents(query);
  };

  return (
    <section className={WORKSPACE_SURFACE_CLASS}>
      <SectionHeader title="事件校准" meta={`${eventDetail.articleCount} 篇 · ${eventSourceCount} 个来源`} />
      <div className="space-y-3 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <StatusPill tone={eventDetail.status === 'active' ? 'success' : 'neutral'}>
            事件：{eventStatusLabel(eventDetail.status)}
          </StatusPill>
          <StatusPill tone={eventDetail.clusterReviewStatus === 'confirmed' ? 'success' : 'warning'}>
            审核：{eventReviewStatusLabel(eventDetail.clusterReviewStatus)}
          </StatusPill>
          <span className="min-w-0 break-words text-muted-foreground">
            时间范围：{timeLabel(eventDetail.firstSeenAt)}—{timeLabel(eventDetail.lastSeenAt)}
          </span>
          <span className="min-w-0 break-words text-muted-foreground">
            代表来源：{eventDetail.representativeArticleId ? (eventDetail.representativeManual ? '人工指定' : '系统选择') : '未确定'}
          </span>
        </div>

        {detail.clusterStatus === 'needs_review' && (
          <div className="grid gap-1.5 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2">
            <p className="text-xs font-medium text-amber-950">
              当前聚类存在歧义。完成复核前，本篇不能成为代表、公开或推送。
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                className={WORKSPACE_BUTTON_CLASS}
                disabled={eventActionPending}
                onClick={onConfirmIndependent}
              >
                确认独立事件
              </Button>
            </div>
          </div>
        )}

        <EventCalibrationGroup
          title="当前成员"
          count={eventMemberModels.length}
          context={(
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {selectedSplitIds.size > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className={`${WORKSPACE_BUTTON_CLASS} text-red-700`}
                  disabled={eventActionPending}
                  onClick={() => onSplitArticles([...selectedSplitIds])}
                >
                  <Split className="h-3 w-3" />移出所选 {selectedSplitIds.size} 篇
                </Button>
              )}
              <span className="inline-flex flex-wrap items-center gap-x-1 whitespace-nowrap text-[11px] text-muted-foreground">
                <span>本篇归类</span>
                <strong className="text-foreground">
                  {currentArticleClassificationAudit ? clusterAuditDecisionSourceLabel(currentArticleClassificationAudit.decisionSource) : '暂无记录'}
                </strong>
                {currentArticleClassificationAudit?.decisionSource === 'ai' && currentArticleClassificationAudit.confidence != null && (
                  <span>
                    · AI 归类判断置信度 <strong className="text-foreground">{currentArticleClassificationAudit.confidence}%</strong>
                  </span>
                )}
              </span>
            </div>
          )}
        >
          <EventArticleList rows={eventMemberModels} />
        </EventCalibrationGroup>

        <EventCalibrationGroup title="候选关联" count={recommendedEventModels.length}>
          {recommendedEventModels.length > 0 ? <EventArticleList rows={recommendedEventModels} /> : <EmptyEventTab>系统当前没有保留可操作的关联候选。</EmptyEventTab>}
        </EventCalibrationGroup>

        <EventCalibrationGroup title="同品牌" count={brandCandidateModels.length}>
          {brandCandidateModels.length > 0 ? <EventArticleList rows={brandCandidateModels} /> : <EmptyEventTab>近 30 天没有找到属于其他事件的同品牌文章。</EmptyEventTab>}
        </EventCalibrationGroup>

        <section className="min-w-0 pb-3 pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="text-xs font-semibold">更改所属事件</h3>
            <span className="text-[11px] text-muted-foreground">移动本篇，或将当前整个事件并入目标事件</span>
          </div>

          <div className="mt-1 flex min-w-0 gap-1">
            <Input
              value={eventSearch}
              onChange={(event) => onEventSearchChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') onSearchEvents(); }}
              placeholder="标题、品牌或事件键"
              className={WORKSPACE_INPUT_CLASS}
            />
            <Button size="sm" variant="outline" className={`${WORKSPACE_BUTTON_CLASS} shrink-0`} onClick={() => onSearchEvents()}>
              <Search className="h-3 w-3" />搜索
            </Button>
          </div>

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="shrink-0 text-muted-foreground">本事件关键词：</span>
            {eventBrands.length > 0 && (
              <>
                <span className="shrink-0 text-muted-foreground">品牌</span>
                {eventBrands.map((brand) => (
                  <button
                    key={`brand-${brand}`}
                    type="button"
                    className={`${WORKSPACE_KEYWORD_CLASS} text-sky-700 hover:bg-sky-50 hover:text-sky-800`}
                    onClick={() => searchEventKeyword(brand)}
                  >
                    {brand}
                  </button>
                ))}
              </>
            )}
            {eventKeyKeywords.length > 0 && (
              <>
                <span className="shrink-0 text-muted-foreground">事件键</span>
                {eventKeyKeywords.map((keyword) => (
                  <button
                    key={`event-key-${keyword}`}
                    type="button"
                    className={`${WORKSPACE_KEYWORD_CLASS} truncate text-sky-700 hover:bg-sky-50 hover:text-sky-800`}
                    title={keyword}
                    onClick={() => searchEventKeyword(keyword)}
                  >
                    {keyword}
                  </button>
                ))}
              </>
            )}
          </div>

          {eventOptions.length > 0 ? (
            <div className="mt-1 max-h-56 overflow-y-auto">
              {eventOptions.map((event) => (
                <EventSearchResult
                  key={event.id}
                  event={event}
                  selected={mergeTargetId === event.id}
                  actionPending={eventActionPending}
                  onMoveCurrentArticle={onMoveCurrentArticle}
                  onSelectMergeTarget={onMergeTargetChange}
                />
              ))}
            </div>
          ) : (
            <p className="mt-1 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              {eventSearch.trim() ? '未找到匹配事件。' : '输入关键词后搜索目标事件。'}
            </p>
          )}

          {mergeTargetId && (
            <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-sky-400 bg-sky-50 px-2 py-1.5 text-xs sm:flex-row sm:items-center">
              <span className="min-w-0 flex-1 break-words">
                整体并入：{eventOptions.find((event) => event.id === mergeTargetId)?.representativeArticle?.title || mergeTargetId}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className={`${WORKSPACE_BUTTON_CLASS} flex-1 sm:flex-none`}
                  disabled={eventActionPending}
                  onClick={() => onMergeTargetChange('')}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={`${WORKSPACE_BUTTON_CLASS} flex-1 border-red-300 text-red-700 sm:flex-none`}
                  disabled={eventActionPending}
                  onClick={onMergeCurrentEvent}
                >
                  <Merge className="h-3 w-3" />确认整体并入
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className={WORKSPACE_SECTION_CLASS}>
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">操作记录</h3>
            <span className="text-[11px] text-muted-foreground">
              最近 {Math.min(currentEventAudits.length, 8)} / {currentEventAudits.length} 条
            </span>
          </div>
          <div className="max-h-[320px] overflow-y-auto divide-y divide-border/60">
            {currentEventAudits.slice(0, 8).map((audit) => {
              const articleTitle = eventArticleTitles.get(audit.articleId)
                || (audit.articleId === detail.id ? detail.title : `文章 ${audit.articleId.slice(-8)}`);
              return (
                <EventAuditRow
                  key={audit.id}
                  audit={audit}
                  articleTitle={articleTitle}
                  isCurrentArticle={audit.articleId === detail.id}
                />
              );
            })}
            {currentEventAudits.length === 0 && <p className="py-3 text-xs text-muted-foreground">暂无操作记录</p>}
          </div>
        </section>
      </div>
    </section>
  );
});

function EventAuditRow({
  audit,
  articleTitle,
  isCurrentArticle,
}: {
  audit: EventAudit;
  articleTitle: string;
  isCurrentArticle: boolean;
}) {
  const evidenceLabels = clusterAuditEvidenceLabels(audit);

  return (
    <article className="grid min-w-0 grid-cols-[3px_minmax(0,1fr)] gap-2 py-2 text-xs">
      <span className={audit.actor === 'admin' ? 'bg-sky-400' : 'bg-slate-300'} aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="bg-muted px-1 py-0.5 font-medium text-foreground">{clusterAuditActionLabel(audit.action)}</span>
          <span>{audit.actor === 'admin' ? '人工执行' : '系统执行'}</span>
          <span>判断来源：{clusterAuditDecisionSourceLabel(audit.decisionSource)}</span>
          {audit.decisionSource === 'ai' && audit.confidence != null && <span>AI 归类判断置信度 {audit.confidence}%</span>}
          <time className="font-mono tabular-nums sm:ml-auto">{fullTimeLabel(audit.createdAt)}</time>
        </div>
        <p className="mt-1 break-words font-normal leading-5">
          {renderAuditOutcome(clusterAuditOutcome(audit, articleTitle), articleTitle, isCurrentArticle)}
        </p>
        {evidenceLabels.length > 0 && (
          <p className="mt-0.5 break-words text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium text-foreground/70">判断依据：</span>{evidenceLabels.join(' · ')}
          </p>
        )}
      </div>
    </article>
  );
}

function renderAuditOutcome(outcome: string, articleTitle: string, highlightArticleTitle: boolean) {
  const titleToken = `《${articleTitle}》`;
  const parts = outcome.split(titleToken);
  if (!highlightArticleTitle || parts.length === 1) return outcome;

  return parts.map((part, index) => (
    <span key={`${part}-${index}`}>
      {index > 0 && <span className="bg-sky-50 px-1 font-semibold text-foreground">{titleToken}</span>}
      {part}
    </span>
  ));
}

function EventSearchResult({
  event,
  selected,
  actionPending,
  onMoveCurrentArticle,
  onSelectMergeTarget,
}: {
  event: EventOption;
  selected: boolean;
  actionPending: boolean;
  onMoveCurrentArticle: (eventId: string) => void;
  onSelectMergeTarget: (eventId: string) => void;
}) {
  return (
    <div className={`grid min-w-0 gap-1 py-1.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${selected ? 'bg-sky-50 px-1.5' : ''}`}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-1">
          {event.representativeArticle && <ScoreBadge score={event.representativeArticle.score} variant="compact-square" />}
          <p className="min-w-0 line-clamp-2 font-medium">{event.representativeArticle?.title || `事件 ${event.id.slice(-8)}`}</p>
        </div>
        {event.representativeArticle?.eventKey && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={event.representativeArticle.eventKey}>
            事件键：{event.representativeArticle.eventKey}
          </p>
        )}
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{event.articleCount} 篇</span>
          <span>{event.representativeArticle?.source.name || '未知来源'}</span>
          <span>{event.publicStatus === 'published' ? '已公开' : '未公开'}</span>
          <span>{event.pushedAt ? '已推送' : '未推送'}</span>
          <span>{fullTimeLabel(event.lastSeenAt)}</span>
        </div>
      </div>
      <div className="flex min-w-0 gap-1 sm:justify-end">
        <Button
          size="sm"
          variant="outline"
          className={`${WORKSPACE_BUTTON_CLASS} flex-1 sm:flex-none`}
          disabled={actionPending}
          onClick={() => onMoveCurrentArticle(event.id)}
        >
          移动本篇
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={`${WORKSPACE_BUTTON_CLASS} flex-1 sm:flex-none`}
          disabled={actionPending}
          onClick={() => onSelectMergeTarget(event.id)}
        >
          {selected ? '已选合并目标' : '合并整个事件'}
        </Button>
      </div>
    </div>
  );
}
