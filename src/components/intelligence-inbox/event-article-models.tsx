'use client';

import { Fragment, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { type EventArticleRowModel } from '@/components/article-workspace/event-article-list';
import type { ArticleDetailDto } from '@/contracts/articles';
import { splitBrands } from '@/lib/shared/article-codecs';
import type { ComparisonTarget, EventAudit, EventDetail } from './types';
import {
  articlePushStatusLabel,
  clusterAuditReason,
  parseEventKeyParts,
  timeDistanceLabel,
  timeLabel,
} from './utils';
import { StatusPill } from './workspace-primitives';
import { WORKSPACE_BUTTON_CLASS, WORKSPACE_COMPACT_BUTTON_CLASS } from './styles';

type RecommendedEvent = NonNullable<EventAudit['candidateEvent']>;
type EventArticle = EventDetail['articles'][number];
type BrandCandidate = EventDetail['brandCandidates'][number];

function normalizedIdentityToken(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchedText(value: string, matched: boolean): ReactNode {
  return (
    <span className={matched ? 'border border-emerald-300 bg-emerald-100 px-1 py-0.5 font-semibold text-emerald-800' : undefined}>
      {value}
    </span>
  );
}

function brandDisplay(value: string, representative: string | null): ReactNode {
  const brands = splitBrands(value);
  if (!representative || brands.length === 0) return value || '—';
  const representativeBrands = new Set(splitBrands(representative).map(normalizedIdentityToken));

  return brands.map((brand, index) => (
    <Fragment key={`${brand}-${index}`}>
      {index > 0 && ' / '}
      {matchedText(brand, representativeBrands.has(normalizedIdentityToken(brand)))}
    </Fragment>
  ));
}

function eventKeyDisplay(value: string, representative: string | null): ReactNode {
  if (!representative || !value) return value || '—';
  const currentParts = parseEventKeyParts(value);
  const representativeParts = parseEventKeyParts(representative);
  const currentSubjects = currentParts.subjects === '—'
    ? []
    : currentParts.subjects.split('+').map((subject) => subject.trim()).filter(Boolean);
  const representativeSubjects = new Set(
    representativeParts.subjects === '—'
      ? []
      : representativeParts.subjects.split('+').map(normalizedIdentityToken),
  );
  const sameAction = currentParts.action !== '—'
    && normalizedIdentityToken(currentParts.action) === normalizedIdentityToken(representativeParts.action);
  const sameObject = currentParts.object !== '—'
    && normalizedIdentityToken(currentParts.object) === normalizedIdentityToken(representativeParts.object);

  return (
    <>
      {currentSubjects.length > 0
        ? currentSubjects.map((subject, index) => (
            <Fragment key={`${subject}-${index}`}>
              {index > 0 && '+'}
              {matchedText(subject, representativeSubjects.has(normalizedIdentityToken(subject)))}
            </Fragment>
          ))
        : currentParts.subjects}
      /
      {matchedText(currentParts.action, sameAction)}
      /
      {matchedText(currentParts.object, sameObject)}
    </>
  );
}

function articleTime(article: Pick<EventArticle, 'publishedAt' | 'createdAt'>): string {
  return timeLabel(article.publishedAt || article.createdAt);
}

function brandLabel(brand: string): string {
  return brand ? splitBrands(brand).join(' / ') : '—';
}

function sourceStatus(source: { deleted: boolean; publicEnabled: boolean }): string {
  return source.deleted ? '来源已删除' : source.publicEnabled ? '来源可公开' : '来源未开放公开';
}

function publicStatus(status: string): string {
  return status === 'published' ? '已公开' : '未公开';
}

interface CreateEventArticleModelsOptions {
  detail: ArticleDetailDto | null;
  eventDetail: EventDetail | null;
  eventMembers: EventDetail['articles'];
  brandCandidates: EventDetail['brandCandidates'];
  selectedSplitIds: Set<string>;
  eventAction: string | null;
  recommendedEventId: string | null;
  recommendedEvent: RecommendedEvent | null;
  recommendedAudit: EventAudit | null;
  setComparisonTarget: (target: ComparisonTarget) => void;
  setRepresentative: (articleId: string) => Promise<void>;
  splitArticle: (articleId: string) => Promise<void>;
  toggleSplitSelection: (articleId: string) => void;
  moveCurrentArticleToEvent: (eventId: string, title: string, actionKey?: string) => Promise<void>;
  moveBrandCandidate: (candidate: BrandCandidate) => Promise<void>;
  moveCurrentArticleToBrandEvent: (candidate: BrandCandidate) => Promise<void>;
  selectArticle: (articleId: string, panel?: 'cluster' | 'content' | null) => void;
}

export function createEventArticleModels({
  detail,
  eventDetail,
  eventMembers,
  brandCandidates,
  selectedSplitIds,
  eventAction,
  recommendedEventId,
  recommendedEvent,
  recommendedAudit,
  setComparisonTarget,
  setRepresentative,
  splitArticle,
  toggleSplitSelection,
  moveCurrentArticleToEvent,
  moveBrandCandidate,
  moveCurrentArticleToBrandEvent,
  selectArticle,
}: CreateEventArticleModelsOptions) {
  const representativeArticle = eventMembers.find(
    (article) => eventDetail?.representativeArticleId === article.id,
  ) ?? null;
  const eventMemberModels: EventArticleRowModel[] = eventMembers.map((article) => {
    const representative = eventDetail?.representativeArticleId === article.id;
    const selected = selectedSplitIds.has(article.id);

    return {
      id: article.id,
      time: articleTime(article),
      score: article.score,
      source: article.source.name,
      title: article.title,
      representative: representative
        ? <StatusPill tone="accent">代表文章</StatusPill>
        : article.id === detail?.id
          ? <span className="bg-sky-50 px-1.5 py-0.5 text-sky-800">当前文章</span>
          : <span className="text-muted-foreground">普通成员</span>,
      brand: brandLabel(article.brand),
      eventKey: article.eventKey || '—',
      brandDisplay: brandDisplay(article.brand, representativeArticle?.brand ?? null),
      eventKeyDisplay: eventKeyDisplay(article.eventKey, representativeArticle?.eventKey ?? null),
      sourceStatus: sourceStatus(article.source),
      publicStatus: publicStatus(article.publicStatus),
      pushStatus: articlePushStatusLabel(article.pushStatus),
      selection: (
        <input
          type="checkbox"
          aria-label={`选择拆分 ${article.title}`}
          checked={selected}
          disabled={(eventDetail?.articleCount ?? 0) <= 1 || eventAction !== null}
          onChange={() => toggleSplitSelection(article.id)}
        />
      ),
      actions: (
        <MemberActions
          article={article}
          representative={representative}
          articleCount={eventDetail?.articleCount ?? 0}
          eventActionPending={eventAction !== null}
          onSetRepresentative={setRepresentative}
          onSplitArticle={splitArticle}
        />
      ),
      tone: 'member',
      highlight: article.id === detail?.id ? 'current' : selected ? 'selected' : representative ? 'representative' : undefined,
      onTitleClick: () => selectArticle(article.id, 'cluster'),
    };
  });

  const recommendedArticle = recommendedEvent?.representativeArticle ?? null;
  const handleMoveToRecommendedEvent = () => {
    if (!recommendedEventId || !recommendedArticle) return;
    void moveCurrentArticleToEvent(
      recommendedEventId,
      recommendedArticle.title,
      `move-recommended:${recommendedEventId}`,
    );
  };

  const recommendedEventModels: EventArticleRowModel[] = recommendedEventId && recommendedEvent && recommendedArticle
    ? (() => {
        const article = recommendedArticle;
        const matchedBrands = detail
          ? splitBrands(article.brand).filter((brand) => splitBrands(detail.brand).includes(brand))
          : [];
        const reason = recommendedAudit ? clusterAuditReason(recommendedAudit) : '';
        const target: ComparisonTarget = {
          kind: 'recommended',
          articleId: null,
          eventId: recommendedEventId,
          title: article.title,
          eventKey: article.eventKey,
          brand: article.brand,
          score: article.score,
          source: article.source.name,
          publishedAt: article.publishedAt,
          createdAt: article.createdAt,
          matchedBrands,
          reason: reason || '聚类系统曾将该事件识别为关联候选',
          confidence: recommendedAudit?.decisionSource === 'ai' ? recommendedAudit.confidence : null,
        };

        return [{
          id: `recommended:${recommendedEventId}`,
          time: articleTime(article),
          score: article.score,
          source: article.source.name,
          title: article.title,
          representative: <StatusPill tone="accent">推荐事件代表</StatusPill>,
          brand: brandLabel(article.brand),
          eventKey: article.eventKey || '—',
          brandDisplay: brandDisplay(article.brand, representativeArticle?.brand ?? null),
          eventKeyDisplay: eventKeyDisplay(article.eventKey, representativeArticle?.eventKey ?? null),
          recommendationInterval: timeDistanceLabel(detail?.publishedAt, article.publishedAt),
          sourceStatus: sourceStatus(article.source),
          publicStatus: publicStatus(recommendedEvent.publicStatus),
          pushStatus: recommendedEvent.pushedAt ? '已推送' : '未推送',
          actions: (
            <>
              <ComparisonButton onClick={() => setComparisonTarget(target)} />
              <Button
                size="sm"
                variant="ghost"
                className={`${WORKSPACE_COMPACT_BUTTON_CLASS} text-sky-700 hover:bg-sky-50 hover:text-sky-800`}
                disabled={eventAction !== null}
                onClick={handleMoveToRecommendedEvent}
              >
                将当前文章移至推荐事件
              </Button>
            </>
          ),
          tone: 'recommended' as const,
        }];
      })()
    : [];

  const brandCandidateModels: EventArticleRowModel[] = brandCandidates.map((candidate) => {
    const target: ComparisonTarget = {
      kind: 'brand',
      articleId: candidate.id,
      eventId: candidate.eventId,
      title: candidate.title,
      eventKey: candidate.eventKey,
      brand: candidate.brand,
      score: candidate.score,
      source: candidate.source.name,
      publishedAt: candidate.publishedAt,
      createdAt: candidate.createdAt,
      matchedBrands: candidate.matchedBrands,
      reason: '近 30 天同品牌文章召回，当前仍属于其他事件',
      confidence: null,
    };

    return {
      id: `brand:${candidate.id}`,
      time: articleTime(candidate),
      score: candidate.score,
      source: candidate.source.name,
      title: candidate.title,
      titleClassName: 'text-amber-950',
      representative: candidate.isEventRepresentative
        ? <StatusPill tone="accent">其他事件代表文章</StatusPill>
        : <span className="text-muted-foreground">其他事件成员</span>,
      brand: brandLabel(candidate.brand),
      eventKey: candidate.eventKey || '—',
      brandDisplay: brandDisplay(candidate.brand, representativeArticle?.brand ?? null),
      eventKeyDisplay: eventKeyDisplay(candidate.eventKey, representativeArticle?.eventKey ?? null),
      recommendationInterval: timeDistanceLabel(detail?.publishedAt, candidate.publishedAt),
      sourceStatus: sourceStatus(candidate.source),
      publicStatus: publicStatus(candidate.publicStatus),
      pushStatus: candidate.eventPushedAt ? '已推送' : '未推送',
      actions: (
        <CandidateActions
          candidate={candidate}
          target={target}
          eventActionPending={eventAction !== null}
          onCompare={setComparisonTarget}
          onMoveCandidate={moveBrandCandidate}
          onMoveCurrentArticle={moveCurrentArticleToBrandEvent}
        />
      ),
      tone: 'brand',
      onTitleClick: () => selectArticle(candidate.id, 'cluster'),
    };
  });

  return { brandCandidateModels, eventMemberModels, recommendedEventModels };
}

function MemberActions({
  article,
  representative,
  articleCount,
  eventActionPending,
  onSetRepresentative,
  onSplitArticle,
}: {
  article: EventArticle;
  representative: boolean;
  articleCount: number;
  eventActionPending: boolean;
  onSetRepresentative: (articleId: string) => Promise<void>;
  onSplitArticle: (articleId: string) => Promise<void>;
}) {
  return (
    <>
      {!representative && (
        <Button
          size="sm"
          variant="ghost"
          className={WORKSPACE_BUTTON_CLASS}
          disabled={eventActionPending || article.clusterStatus !== 'clustered' || article.aiStatus !== 'done' || article.source.deleted}
          onClick={() => void onSetRepresentative(article.id)}
        >
          设为代表文章
        </Button>
      )}
      {!representative && articleCount > 1 && (
        <Button
          size="sm"
          variant="ghost"
          className={`${WORKSPACE_BUTTON_CLASS} text-red-700 hover:bg-red-50 hover:text-red-800`}
          disabled={eventActionPending}
          onClick={() => void onSplitArticle(article.id)}
        >
          移出为独立事件
        </Button>
      )}
    </>
  );
}

function ComparisonButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={`${WORKSPACE_COMPACT_BUTTON_CLASS} text-slate-600 hover:bg-slate-100 hover:text-slate-900`}
      onClick={onClick}
    >
      查看对比
    </Button>
  );
}

function CandidateActions({
  candidate,
  target,
  eventActionPending,
  onCompare,
  onMoveCandidate,
  onMoveCurrentArticle,
}: {
  candidate: BrandCandidate;
  target: ComparisonTarget;
  eventActionPending: boolean;
  onCompare: (target: ComparisonTarget) => void;
  onMoveCandidate: (candidate: BrandCandidate) => Promise<void>;
  onMoveCurrentArticle: (candidate: BrandCandidate) => Promise<void>;
}) {
  return (
    <>
      <ComparisonButton onClick={() => onCompare(target)} />
      <Button
        size="sm"
        variant="ghost"
        className={`${WORKSPACE_COMPACT_BUTTON_CLASS} text-amber-700 hover:bg-amber-50 hover:text-amber-800`}
        title="将这篇候选文章加入当前文章所属事件"
        disabled={eventActionPending}
        onClick={() => void onMoveCandidate(candidate)}
      >
        并入当前事件
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={`${WORKSPACE_COMPACT_BUTTON_CLASS} text-sky-700 hover:bg-sky-50 hover:text-sky-800`}
        title="将当前文章移入这篇文章所属事件"
        disabled={eventActionPending}
        onClick={() => void onMoveCurrentArticle(candidate)}
      >
        将当前文章移至该事件
      </Button>
    </>
  );
}
