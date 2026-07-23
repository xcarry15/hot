import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { splitBrands } from '@/lib/shared/article-codecs';
import { getPushTargetStates } from '@/lib/push/delivery';
import { isRepresentativeEligible as isReleaseRepresentativeEligible } from '@/lib/event-release-policy';

const SAME_BRAND_CANDIDATE_TAKE = 30;
const SAME_BRAND_CANDIDATE_WINDOW_DAYS = 30;

type EventTransaction = Prisma.TransactionClient;

export type RepresentativeCandidate = {
  id: string;
  clusterStatus: string;
  aiStatus: string;
  reviewStatus: string;
  score: number;
  relevance: number;
  cleanContent: string;
  publishedAt: Date | null;
  createdAt: Date;
  source: { publicEnabled: boolean; deletedAt: Date | null };
};

function eventDate(article: { publishedAt: Date | null; createdAt: Date }): Date {
  return article.publishedAt ?? article.createdAt;
}

export function sharedBrands(left: string, right: string): string[] {
  const rightBrands = new Set(splitBrands(right));
  return splitBrands(left).filter((brand) => rightBrands.has(brand));
}

function compareArticleTime(
  left: { publishedAt: Date | null; createdAt: Date },
  right: { publishedAt: Date | null; createdAt: Date },
): number {
  const timeDiff = eventDate(right).getTime() - eventDate(left).getTime();
  if (timeDiff !== 0) return timeDiff;
  return right.createdAt.getTime() - left.createdAt.getTime();
}

async function getSameBrandCandidates(eventId: string, brand: string) {
  const brands = splitBrands(brand);
  if (brands.length === 0) return [];

  const cutoff = new Date(Date.now() - SAME_BRAND_CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const timeWindow = {
    OR: [
      { publishedAt: { gte: cutoff } },
      { publishedAt: null, createdAt: { gte: cutoff } },
    ],
  };
  const baseWhere = {
    eventId: { not: eventId },
    aiStatus: 'done',
    event: { is: { status: 'active' } },
    source: { deletedAt: null },
  } as const;
  const select = {
    id: true,
    eventId: true,
    title: true,
    url: true,
    eventKey: true,
    score: true,
    relevance: true,
    brand: true,
    reviewStatus: true,
    publicStatus: true,
    publishedAt: true,
    createdAt: true,
    source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
    event: { select: { pushedAt: true, representativeArticleId: true } },
  } as const;

  // 先命中完全相同的品牌字段，再用品牌片段补齐多品牌/历史格式数据。
  const exact = await db.article.findMany({
    where: { ...baseWhere, ...timeWindow, brand: { equals: brand } },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: SAME_BRAND_CANDIDATE_TAKE * 2,
    select,
  });
  const broad = exact.length >= SAME_BRAND_CANDIDATE_TAKE
    ? []
    : await db.article.findMany({
        where: {
          ...baseWhere,
          AND: [
            timeWindow,
            { OR: brands.map((item) => ({ brand: { contains: item } })) },
          ],
        },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: SAME_BRAND_CANDIDATE_TAKE * 4,
        select,
      });

  const candidates = [...exact, ...broad]
    .filter((article, index, all) => all.findIndex((item) => item.id === article.id) === index)
    .map((article) => ({
      ...article,
      matchedBrands: sharedBrands(brand, article.brand),
    }))
    .filter((article) => article.matchedBrands.length > 0)
    .sort(compareArticleTime)
    .slice(0, SAME_BRAND_CANDIDATE_TAKE);

  return candidates.map(({ event, source, ...article }) => ({
    ...article,
    eventPushedAt: event?.pushedAt?.toISOString() ?? null,
    isEventRepresentative: event?.representativeArticleId === article.id,
    source: {
      name: source.name,
      type: source.type,
      publicEnabled: source.publicEnabled,
      deleted: source.deletedAt !== null,
    },
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: article.createdAt.toISOString(),
  }));
}

export function deriveEventClusterReviewStatus(clusterStatuses: readonly string[]): 'confirmed' | 'pending' {
  return clusterStatuses.some((status) => status === 'needs_review') ? 'pending' : 'confirmed';
}

export function isRepresentativeEligible(article: RepresentativeCandidate): boolean {
  return isReleaseRepresentativeEligible(article);
}

export function selectRepresentativeCandidate(articles: RepresentativeCandidate[]): string | null {
  const ready = articles.filter(isReleaseRepresentativeEligible);
  ready.sort(compareRepresentative);
  return ready[0]?.id ?? null;
}

function compareRepresentative(left: RepresentativeCandidate, right: RepresentativeCandidate): number {
  const ready = Number(isReleaseRepresentativeEligible(right)) - Number(isReleaseRepresentativeEligible(left));
  if (ready !== 0) return ready;
  const important = Number(right.reviewStatus === 'important') - Number(left.reviewStatus === 'important');
  if (important !== 0) return important;
  if (right.score !== left.score) return right.score - left.score;
  if (right.relevance !== left.relevance) return right.relevance - left.relevance;
  if (right.cleanContent.length !== left.cleanContent.length) return right.cleanContent.length - left.cleanContent.length;
  return eventDate(left).getTime() - eventDate(right).getTime();
}

async function chooseRepresentative(client: EventTransaction, eventId: string): Promise<{ id: string | null; manual: boolean }> {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { representativeArticleId: true, representativeManual: true },
  });
  if (!event) return { id: null, manual: false };
  if (event.representativeManual && event.representativeArticleId) {
    const manual = await client.article.findFirst({
      where: { id: event.representativeArticleId, eventId },
      select: {
        id: true, clusterStatus: true, aiStatus: true, reviewStatus: true, score: true, relevance: true,
        cleanContent: true, publishedAt: true, createdAt: true,
        source: { select: { publicEnabled: true, deletedAt: true } },
      },
    });
    if (manual && isReleaseRepresentativeEligible(manual)) return { id: manual.id, manual: true };
  }
  const articles = await client.article.findMany({
    where: { eventId },
    select: {
      id: true,
      clusterStatus: true,
      aiStatus: true,
      reviewStatus: true,
      score: true,
      relevance: true,
      cleanContent: true,
      publishedAt: true,
      createdAt: true,
      source: { select: { publicEnabled: true, deletedAt: true } },
    },
  });
  return { id: selectRepresentativeCandidate(articles), manual: false };
}

async function recalculateEvent(client: EventTransaction, eventId: string): Promise<void> {
  const articles = await client.article.findMany({
    where: { eventId },
    select: { id: true, publishedAt: true, createdAt: true, clusterStatus: true },
  });
  if (articles.length === 0) {
    await client.event.update({
      where: { id: eventId },
      data: {
        status: 'merged',
        clusterReviewStatus: 'confirmed',
        representativeArticleId: null,
        representativeManual: false,
        articleCount: 0,
        publicStatus: 'revoked',
        publicDateKey: '',
        publicSortAt: null,
      },
    });
    return;
  }
  const dates = articles.map(eventDate);
  const clusterReviewStatus = deriveEventClusterReviewStatus(articles.map((article) => article.clusterStatus));
  const representative = clusterReviewStatus === 'confirmed'
    ? await chooseRepresentative(client, eventId)
    : { id: null, manual: false };
  await client.event.update({
    where: { id: eventId },
    data: {
      status: 'active',
      clusterReviewStatus,
      articleCount: articles.length,
      firstSeenAt: new Date(Math.min(...dates.map((date) => date.getTime()))),
      lastSeenAt: new Date(Math.max(...dates.map((date) => date.getTime()))),
      representativeArticleId: representative.id,
      representativeManual: representative.manual,
    },
  });
}

export async function recalculateEventsInTransaction(
  client: EventTransaction,
  eventIds: string[],
): Promise<void> {
  for (const eventId of [...new Set(eventIds.filter(Boolean))]) {
    await recalculateEvent(client, eventId);
  }
}

export async function recalculateArticleEvent(articleId: string): Promise<void> {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { eventId: true } });
  if (!article?.eventId) return;
  await db.$transaction((tx) => recalculateEvent(tx, article.eventId!));
  await refreshEventPublicPublication(article.eventId);
  invalidatePublicArticleCache();
}

export async function recalculateEventById(eventId: string): Promise<void> {
  await db.$transaction((tx) => recalculateEvent(tx, eventId));
  await refreshEventPublicPublication(eventId);
  invalidatePublicArticleCache();
}

export interface ArticleDeletionEventResult {
  eventExists: boolean;
  pushLogsDeleted: number;
  representativeArticleId: string | null;
}

export async function reconcileEventAfterArticleDeletionInTransaction(
  client: EventTransaction,
  eventId: string,
): Promise<ArticleDeletionEventResult> {
  const event = await client.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) return { eventExists: false, pushLogsDeleted: 0, representativeArticleId: null };

  const articleCount = await client.article.count({ where: { eventId } });
  if (articleCount === 0) {
    // Event 保留为归档记录，PushLog/PushDelivery 才能继续承担历史审计职责。
    await client.event.update({
      where: { id: eventId },
      data: {
        status: 'merged',
        clusterReviewStatus: 'confirmed',
        representativeArticleId: null,
        representativeManual: false,
        articleCount: 0,
        publicStatus: 'revoked',
        publicRevokedAt: new Date(),
        publicDateKey: '',
        publicSortAt: null,
        nextPushRetryAt: null,
        pushRetryCount: 0,
      },
    });
    return { eventExists: true, pushLogsDeleted: 0, representativeArticleId: null };
  }

  await recalculateEvent(client, eventId);
  const updated = await client.event.findUnique({
    where: { id: eventId },
    select: { representativeArticleId: true },
  });
  return { eventExists: true, pushLogsDeleted: 0, representativeArticleId: updated?.representativeArticleId ?? null };
}

export async function reconcileEventAfterArticleDeletion(eventId: string): Promise<{ pushLogsDeleted: number }> {
  const result = await db.$transaction((tx) => reconcileEventAfterArticleDeletionInTransaction(tx, eventId));
  if (result.eventExists) {
    await refreshEventPublicPublication(eventId);
  }
  invalidatePublicArticleCache();
  return { pushLogsDeleted: result.pushLogsDeleted };
}

export async function getEventArticles(eventId: string, articleId?: string) {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      status: true,
      clusterReviewStatus: true,
      representativeArticleId: true,
      representativeManual: true,
      articleCount: true,
      publicStatus: true,
      pushedAt: true,
      firstSeenAt: true,
      lastSeenAt: true,
      pushLogs: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          representativeArticleId: true,
          targetId: true,
          status: true,
          webhookUrl: true,
          webhookRemark: true,
        },
      },
      articles: {
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          url: true,
          eventKey: true,
          score: true,
          relevance: true,
          eventScore: true,
          contentScore: true,
          aiConfidence: true,
          aiStatus: true,
          publicStatus: true,
          publicOverride: true,
          isAd: true,
          brand: true,
          category: true,
          reviewStatus: true,
          clusterStatus: true,
          publishedAt: true,
          createdAt: true,
          source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
        },
      },
      assignedAudits: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          articleId: true,
          candidateEventId: true,
          actor: true,
          action: true,
          decisionSource: true,
          confidence: true,
          evidence: true,
          createdAt: true,
          candidateEvent: {
            select: {
              id: true,
              status: true,
              articleCount: true,
              publicStatus: true,
              pushedAt: true,
              representativeArticle: {
                select: {
                  title: true,
                  eventKey: true,
                  score: true,
                  brand: true,
                  reviewStatus: true,
                  publishedAt: true,
                  createdAt: true,
                  source: { select: { name: true, type: true, publicEnabled: true, deletedAt: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!event) return null;
  const { pushLogs, ...eventData } = event;
  const articlePushStatuses = getLatestArticlePushStatuses(pushLogs);
  const currentDeliveries = await db.pushDelivery.findMany({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
    select: { targetId: true, status: true },
  });
  const currentRepresentativeStatus = getPushStatusFromDeliveries(currentDeliveries);
  if (event.representativeArticleId && currentRepresentativeStatus !== 'none') {
    articlePushStatuses.set(event.representativeArticleId, currentRepresentativeStatus);
  }
  const focusArticle = event.articles.find((article) => article.id === articleId)
    ?? event.articles.find((article) => article.id === event.representativeArticleId)
    ?? event.articles[0];
  const brandCandidates = focusArticle
    ? await getSameBrandCandidates(eventId, focusArticle.brand)
    : [];
  const parsedAudits = event.assignedAudits.map((audit) => ({ ...audit, evidence: parseAuditEvidence(audit.evidence) }));
  const candidateIds = [...new Set(parsedAudits.flatMap((audit) => {
    const candidates = audit.evidence.candidates;
    if (!Array.isArray(candidates)) return [];
    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const id = (candidate as { candidateEventId?: unknown }).candidateEventId;
      return typeof id === 'string' ? [id] : [];
    });
  }))];
  const candidateEvents = candidateIds.length === 0 ? [] : await db.event.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, representativeArticle: { select: { title: true } } },
  });
  const candidateTitles = new Map(candidateEvents.map((candidate) => [candidate.id, candidate.representativeArticle?.title ?? '']));
  const pushTargetStates = await getPushTargetStates(eventId);
  return {
    ...eventData,
    pushedAt: event.pushedAt?.toISOString() ?? null,
    firstSeenAt: event.firstSeenAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
    pushTargetStates: pushTargetStates.map((s) => ({
      ...s,
      latestCreatedAt: s.latestCreatedAt?.toISOString() ?? null,
    })),
    audits: parsedAudits.map((audit) => ({
      ...audit,
      evidence: {
        ...audit.evidence,
        ...(Array.isArray(audit.evidence.candidates) ? {
          candidates: audit.evidence.candidates.map((candidate) => {
            if (!candidate || typeof candidate !== 'object') return candidate;
            const value = candidate as Record<string, unknown>;
            const id = typeof value.candidateEventId === 'string' ? value.candidateEventId : '';
            return { ...value, candidateTitle: candidateTitles.get(id) || '' };
          }),
        } : {}),
      },
      createdAt: audit.createdAt.toISOString(),
      candidateEvent: audit.candidateEvent ? {
        ...audit.candidateEvent,
        pushedAt: audit.candidateEvent.pushedAt?.toISOString() ?? null,
        representativeArticle: audit.candidateEvent.representativeArticle ? {
          ...audit.candidateEvent.representativeArticle,
          publishedAt: audit.candidateEvent.representativeArticle.publishedAt?.toISOString() ?? null,
          createdAt: audit.candidateEvent.representativeArticle.createdAt.toISOString(),
          source: {
            name: audit.candidateEvent.representativeArticle.source.name,
            type: audit.candidateEvent.representativeArticle.source.type,
            publicEnabled: audit.candidateEvent.representativeArticle.source.publicEnabled,
            deleted: audit.candidateEvent.representativeArticle.source.deletedAt !== null,
          },
        } : null,
      } : null,
    })),
    articles: event.articles.map((article) => ({
      ...article,
      pushStatus: articlePushStatuses.get(article.id) ?? 'none',
      source: {
        name: article.source.name,
        type: article.source.type,
        publicEnabled: article.source.publicEnabled,
        deleted: article.source.deletedAt !== null,
      },
      publishedAt: article.publishedAt?.toISOString() ?? null,
      createdAt: article.createdAt.toISOString(),
    })),
    brandCandidates,
  };
}

function parseAuditEvidence(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

type ArticlePushStatus = 'success' | 'partial' | 'failure' | 'none';

function getLatestArticlePushStatuses(logs: Array<{
  id: string;
  representativeArticleId: string | null;
  targetId: string | null;
  status: string;
  webhookUrl: string;
  webhookRemark: string;
}>): Map<string, ArticlePushStatus> {
  const latestByTarget = new Map<string, (typeof logs)[number]>();
  for (const log of logs) {
    const target = log.targetId || log.webhookRemark || log.webhookUrl || log.id;
    if (!latestByTarget.has(target)) latestByTarget.set(target, log);
  }

  const statuses = new Map<string, { success: boolean; failure: boolean }>();
  for (const log of latestByTarget.values()) {
    if (!log.representativeArticleId) continue;
    const current = statuses.get(log.representativeArticleId) ?? { success: false, failure: false };
    if (log.status === 'success') current.success = true;
    else current.failure = true;
    statuses.set(log.representativeArticleId, current);
  }

  return new Map([...statuses].map(([articleId, status]) => [
    articleId,
    status.success && status.failure
      ? 'partial'
      : status.success
        ? 'success'
        : 'failure',
  ]));
}

function getPushStatusFromDeliveries(deliveries: Array<{ targetId: string; status: string }>): ArticlePushStatus {
  const latestByTarget = new Map<string, (typeof deliveries)[number]>();
  for (const delivery of deliveries) {
    if (!latestByTarget.has(delivery.targetId)) latestByTarget.set(delivery.targetId, delivery);
  }
  const latest = [...latestByTarget.values()];
  if (latest.length === 0) return 'none';
  const successCount = latest.filter((delivery) => delivery.status === 'succeeded').length;
  const attemptedCount = latest.filter((delivery) => delivery.status !== 'pending').length;
  if (attemptedCount === 0) return 'none';
  if (successCount === latest.length) return 'success';
  if (successCount > 0) return 'partial';
  return 'failure';
}

async function refreshEventRepresentatives(eventIds: string[]): Promise<void> {
  for (const eventId of [...new Set(eventIds)]) await refreshEventPublicPublication(eventId);
  invalidatePublicArticleCache();
}

export async function confirmIndependentArticle(eventId: string, articleId: string): Promise<boolean> {
  const updated = await db.$transaction(async (tx) => {
    const article = await tx.article.findFirst({
      where: { id: articleId, eventId, clusterStatus: 'needs_review' },
      select: { id: true },
    });
    if (!article) return false;
    await tx.article.update({
      where: { id: articleId },
      data: { clusterStatus: 'clustered', clusteredAt: new Date(), clusterError: null },
    });
    await recalculateEvent(tx, eventId);
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: eventId,
        actor: 'admin',
        action: 'confirm_independent',
        decisionSource: 'admin',
        confidence: 100,
        evidence: JSON.stringify({ eventId }),
      },
    });
    return true;
  });
  if (updated) await refreshEventRepresentatives([eventId]);
  return updated;
}

export async function moveArticleToEvent(articleId: string, targetEventId: string): Promise<boolean> {
  const result = await db.$transaction(async (tx) => {
    const [article, target] = await Promise.all([
      tx.article.findUnique({
        where: { id: articleId },
        select: {
          id: true, eventId: true, aiStatus: true, clusterStatus: true,
          eventKey: true,
        },
      }),
      tx.event.findUnique({
        where: { id: targetEventId },
        select: { id: true, status: true },
      }),
    ]);
    if (!article?.eventId || article.eventId === targetEventId || target?.status !== 'active') return null;
    const sourceEventId = article.eventId;
    // P1-7: 不得通过移动隐式绕过技术门禁
    const canCluster = article.aiStatus === 'done';
    await tx.article.update({
      where: { id: articleId },
      data: {
        eventId: targetEventId,
        clusterStatus: canCluster ? 'clustered' : article.clusterStatus,
        clusteredAt: canCluster ? new Date() : undefined,
        clusterError: null,
      },
    });
    await recalculateEvent(tx, sourceEventId);
    await recalculateEvent(tx, targetEventId);
    await tx.eventDirty.createMany({
      data: [
        { eventId: sourceEventId, reason: `article ${articleId} moved out to ${targetEventId}` },
        { eventId: targetEventId, reason: `article ${articleId} moved in from ${sourceEventId}` },
      ],
    });
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: targetEventId,
        candidateEventId: sourceEventId,
        actor: 'admin',
        action: 'move',
        decisionSource: 'admin',
        confidence: 100,
        evidence: JSON.stringify({
          sourceEventId,
          targetEventId,
          articleEventKey: article.eventKey,
        }),
      },
    });
    return { sourceEventId };
  });
  if (!result) return false;
  await refreshEventRepresentatives([result.sourceEventId, targetEventId]);
  return true;
}

export async function searchActiveEvents(query: string, excludeEventId?: string) {
  const term = query.trim();
  const events = await db.event.findMany({
    where: {
      status: 'active',
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
      ...(term ? {
        OR: [
          { id: { contains: term } },
          { representativeArticle: { is: { title: { contains: term } } } },
          { articles: { some: { OR: [
            { title: { contains: term } },
            { brand: { contains: term } },
            { eventKey: { contains: term } },
          ] } } },
        ],
      } : { lastSeenAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }),
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 20,
    select: {
      id: true,
      articleCount: true,
      lastSeenAt: true,
      publicStatus: true,
      pushedAt: true,
      representativeArticle: {
        select: {
          title: true,
          score: true,
          relevance: true,
          publishedAt: true,
          source: { select: { name: true } },
        },
      },
    },
  });
  return events.map((event) => ({
    ...event,
    lastSeenAt: event.lastSeenAt.toISOString(),
    pushedAt: event.pushedAt?.toISOString() ?? null,
    representativeArticle: event.representativeArticle ? {
      ...event.representativeArticle,
      publishedAt: event.representativeArticle.publishedAt?.toISOString() ?? null,
    } : null,
  }));
}

export async function setEventRepresentative(eventId: string, articleId: string): Promise<boolean> {
  const [event, member] = await Promise.all([
    db.event.findUnique({ where: { id: eventId }, select: { status: true, clusterReviewStatus: true } }),
    db.article.findFirst({
      where: { id: articleId, eventId },
      select: {
        id: true, clusterStatus: true, aiStatus: true, reviewStatus: true, score: true, relevance: true,
        cleanContent: true, publishedAt: true, createdAt: true,
        source: { select: { publicEnabled: true, deletedAt: true } },
      },
    }),
  ]);
  if (event?.status !== 'active' || event.clusterReviewStatus !== 'confirmed' || !member || !isReleaseRepresentativeEligible(member)) return false;
  await db.$transaction(async (tx) => {
    await tx.event.update({
      where: { id: eventId },
      data: { representativeArticleId: articleId, representativeManual: true },
    });
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: eventId,
        actor: 'admin',
        action: 'representative_change',
        decisionSource: 'admin',
        confidence: 100,
        evidence: JSON.stringify({ representativeArticleId: articleId }),
      },
    });
  });
  await refreshEventPublicPublication(eventId);
  invalidatePublicArticleCache();
  return true;
}

export async function mergeEvents(sourceEventId: string, targetEventId: string): Promise<boolean> {
  if (!sourceEventId || !targetEventId || sourceEventId === targetEventId) return false;
  const result = await db.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.event.findUnique({ where: { id: sourceEventId }, select: { id: true, status: true, pushedAt: true, articles: { select: { id: true } } } }),
      tx.event.findUnique({ where: { id: targetEventId }, select: { id: true, status: true, pushedAt: true } }),
    ]);
    if (!source || !target || source.status !== 'active' || target.status !== 'active') return false;
    await tx.article.updateMany({ where: { eventId: sourceEventId }, data: { eventId: targetEventId } });
    for (const article of source.articles) {
      await tx.eventClusterAudit.create({
        data: {
          articleId: article.id,
          assignedEventId: targetEventId,
          candidateEventId: sourceEventId,
          actor: 'admin',
          action: 'merge',
          decisionSource: 'admin',
          confidence: 100,
          evidence: JSON.stringify({ sourceEventId, targetEventId }),
        },
      });
    }
    await tx.event.update({
      where: { id: sourceEventId },
      data: {
        status: 'merged',
        clusterReviewStatus: 'confirmed',
        mergedIntoId: targetEventId,
        representativeArticleId: null,
        representativeManual: false,
        articleCount: 0,
        publicStatus: 'revoked',
        publicRevokedAt: new Date(),
        publicDateKey: '',
        publicSortAt: null,
      },
    });
    // P0-5: 禁止复制 pushedAt — 合并后重新计算投递状态
    await recalculateEvent(tx, targetEventId);
    // 源 Event 合并后标记为脏，使 Reconciler 处理投递状态对齐
    await tx.eventDirty.create({
      data: { eventId: targetEventId, reason: `merged from ${sourceEventId}` },
    });
    return true;
  });
  if (result) {
    await refreshEventPublicPublication(targetEventId);
    invalidatePublicArticleCache();
  }
  return result;
}

export async function splitEventArticles(eventId: string, articleIds: string[]): Promise<string | null> {
  const ids = [...new Set(articleIds.filter(Boolean))];
  if (ids.length === 0) return null;
  const newEventId = await db.$transaction(async (tx) => {
    const sourceEvent = await tx.event.findUnique({ where: { id: eventId }, select: { status: true } });
    if (!sourceEvent || sourceEvent.status !== 'active') return null;
    const articles = await tx.article.findMany({
      where: { id: { in: ids }, eventId },
      select: { id: true, publishedAt: true, createdAt: true, aiStatus: true, clusterStatus: true },
    });
    const total = await tx.article.count({ where: { eventId } });
    if (articles.length !== ids.length || articles.length >= total) return null;
    const dates = articles.map(eventDate);
  const created = await tx.event.create({
      data: {
        firstSeenAt: new Date(Math.min(...dates.map((date) => date.getTime()))),
        lastSeenAt: new Date(Math.max(...dates.map((date) => date.getTime()))),
        articleCount: articles.length,
        representativeArticleId: null,
      },
      select: { id: true },
    });
    await tx.article.updateMany({
      where: { id: { in: ids }, eventId },
      data: { eventId: created.id },
    });
    // P1-7: 只把 AI 完成的文章设为 clustered，不绕过技术门禁
    for (const article of articles) {
      if (article.aiStatus === 'done') {
        await tx.article.update({
          where: { id: article.id },
          data: { clusterStatus: 'clustered', clusteredAt: new Date() },
        });
      }
    }
    await recalculateEvent(tx, created.id);
    for (const article of articles) {
      await tx.eventClusterAudit.create({
        data: {
          articleId: article.id,
          assignedEventId: created.id,
          candidateEventId: eventId,
          actor: 'admin',
          action: 'manual_create',
          decisionSource: 'admin',
          confidence: 100,
          evidence: JSON.stringify({ sourceEventId: eventId, newEventId: created.id }),
        },
      });
    }
    await recalculateEvent(tx, eventId);
    await tx.eventDirty.createMany({
      data: [
        { eventId: created.id, reason: `split from ${eventId}` },
        { eventId, reason: `split to ${created.id}` },
      ],
    });
    return created.id;
  });
  if (newEventId) {
    await refreshEventPublicPublication(eventId);
    await refreshEventPublicPublication(newEventId);
    invalidatePublicArticleCache();
  }
  return newEventId;
}

export interface ConsistencyViolation {
  eventId: string;
  issue: string;
  severity: 'error' | 'warning';
}

/**
 * Event 一致性扫描器 (P0). 检查所有 Event 的派生状态是否与基础事实一致。
 * 返回违规列表；空数组表示完全一致。
 */
export async function scanEventConsistency(): Promise<ConsistencyViolation[]> {
  const violations: ConsistencyViolation[] = [];
  const events = await db.event.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      articleCount: true,
      representativeArticleId: true,
      representativeManual: true,
      publicStatus: true,
      clusterReviewStatus: true,
      pushedAt: true,
      representativeArticle: { select: { id: true, clusterStatus: true, aiStatus: true, eventId: true } },
      articles: { select: { id: true, clusterStatus: true } },
    },
  });

  for (const event of events) {
    // articleCount 与实际成员数不一致
    const actualCount = event.articles.length;
    if (event.articleCount !== actualCount) {
      violations.push({
        eventId: event.id,
        issue: `articleCount=${event.articleCount} 实际=${actualCount}`,
        severity: 'error',
      });
    }

    // representativeArticle 不属于当前 Event
    if (event.representativeArticleId && event.representativeArticle?.eventId !== event.id) {
      violations.push({
        eventId: event.id,
        issue: `代表文章 ${event.representativeArticleId} 不属于当前 Event`,
        severity: 'error',
      });
    }

    // 非代表 Article 处于 published 状态
    // (handled by public-publication-service, but check here)

    // pending Event 有代表文章
    if (event.clusterReviewStatus === 'pending' && event.representativeArticleId) {
      violations.push({
        eventId: event.id,
        issue: '待复核 Event 不应有代表文章',
        severity: 'warning',
      });
    }

    // 空 Event 仍为 active
    if (actualCount === 0) {
      violations.push({
        eventId: event.id,
        issue: '空 Event 仍保持 active',
        severity: 'error',
      });
    }

    // representativeArticle 不可用
    if (event.representativeArticleId && event.representativeArticle) {
      const rep = event.representativeArticle;
      if (rep.clusterStatus !== 'clustered' || rep.aiStatus !== 'done') {
        violations.push({
          eventId: event.id,
          issue: `代表文章 ${rep.id} 不可用 (cluster=${rep.clusterStatus}, ai=${rep.aiStatus})`,
          severity: 'warning',
        });
      }
    }
  }

  // Check merged Events that should be cleaned
  const mergedEvents = await db.event.findMany({
    where: {
      status: 'merged',
      articles: { some: {} },
    },
    select: { id: true },
  });
  for (const event of mergedEvents) {
    violations.push({
      eventId: event.id,
      issue: '已合并 Event 仍有成员文章',
      severity: 'error',
    });
  }

  // Check for orphaned EventDirty records
  const dirtyCount = await db.eventDirty.count();
  if (dirtyCount > 0) {
    violations.push({
      eventId: '(system)',
      issue: `${dirtyCount} 个 Event 标记为脏，等待 Reconcile`,
      severity: 'warning',
    });
  }

  return violations;
}

/**
 * 自动修复已知的不一致。批处理，不中断。
 */
export async function autoRepairEventConsistency(): Promise<number> {
  let repairs = 0;

  // Fix: articleCount mismatches
  const events = await db.event.findMany({
    where: { status: 'active' },
    select: { id: true },
  });
  for (const { id } of events) {
    await recalculateEventById(id);
    repairs++;
  }

  // Cleanup: remove stale EventDirty entries for repaired Events
  await db.eventDirty.deleteMany();

  return repairs;
}
