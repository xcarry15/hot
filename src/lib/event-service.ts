import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';

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

export function deriveEventClusterReviewStatus(clusterStatuses: readonly string[]): 'confirmed' | 'pending' {
  return clusterStatuses.some((status) => status === 'needs_review') ? 'pending' : 'confirmed';
}

function representativeReady(article: RepresentativeCandidate): boolean {
  return article.clusterStatus === 'clustered'
    && article.aiStatus === 'done'
    && article.source.deletedAt === null;
}

export function isRepresentativeEligible(article: RepresentativeCandidate): boolean {
  return representativeReady(article);
}

export function selectRepresentativeCandidate(articles: RepresentativeCandidate[]): string | null {
  const ready = articles.filter(representativeReady);
  ready.sort(compareRepresentative);
  return ready[0]?.id ?? null;
}

function compareRepresentative(left: RepresentativeCandidate, right: RepresentativeCandidate): number {
  const ready = Number(representativeReady(right)) - Number(representativeReady(left));
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
    if (manual && representativeReady(manual)) return { id: manual.id, manual: true };
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

export async function reconcileEventAfterArticleDeletion(eventId: string): Promise<{ pushLogsDeleted: number }> {
  const result = await db.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) return { pushLogsDeleted: 0, representativeArticleId: null as string | null };
    const articleCount = await tx.article.count({ where: { eventId } });
    if (articleCount === 0) {
      const pushLogs = await tx.pushLog.deleteMany({ where: { eventId } });
      await tx.eventClusterAudit.deleteMany({
        where: { OR: [{ assignedEventId: eventId }, { candidateEventId: eventId }] },
      });
      await tx.event.updateMany({
        where: { mergedIntoId: eventId },
        data: { mergedIntoId: null },
      });
      await tx.event.delete({ where: { id: eventId } });
      return { pushLogsDeleted: pushLogs.count, representativeArticleId: null as string | null };
    }
    await recalculateEvent(tx, eventId);
    const updated = await tx.event.findUnique({ where: { id: eventId }, select: { representativeArticleId: true } });
    return { pushLogsDeleted: 0, representativeArticleId: updated?.representativeArticleId ?? null };
  });
  if (result.representativeArticleId) await refreshEventPublicPublication(eventId);
  invalidatePublicArticleCache();
  return { pushLogsDeleted: result.pushLogsDeleted };
}

export async function getEventArticles(eventId: string) {
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
              representativeArticle: { select: { title: true } },
            },
          },
        },
      },
    },
  });
  if (!event) return null;
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
  return {
    ...event,
    pushedAt: event.pushedAt?.toISOString() ?? null,
    firstSeenAt: event.firstSeenAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
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
    })),
    articles: event.articles.map((article) => ({
      ...article,
      source: {
        name: article.source.name,
        type: article.source.type,
        publicEnabled: article.source.publicEnabled,
        deleted: article.source.deletedAt !== null,
      },
      publishedAt: article.publishedAt?.toISOString() ?? null,
      createdAt: article.createdAt.toISOString(),
    })),
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
      tx.article.findUnique({ where: { id: articleId }, select: { id: true, eventId: true } }),
      tx.event.findUnique({ where: { id: targetEventId }, select: { id: true, status: true } }),
    ]);
    if (!article?.eventId || article.eventId === targetEventId || target?.status !== 'active') return null;
    const sourceEventId = article.eventId;
    await tx.article.update({
      where: { id: articleId },
      data: { eventId: targetEventId, clusterStatus: 'clustered', clusteredAt: new Date(), clusterError: null },
    });
    await recalculateEvent(tx, sourceEventId);
    await recalculateEvent(tx, targetEventId);
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: targetEventId,
        candidateEventId: sourceEventId,
        actor: 'admin',
        action: 'move',
        decisionSource: 'admin',
        confidence: 100,
        evidence: JSON.stringify({ sourceEventId, targetEventId }),
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
  if (event?.status !== 'active' || event.clusterReviewStatus !== 'confirmed' || !member || !representativeReady(member)) return false;
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
    await tx.article.updateMany({ where: { eventId: sourceEventId }, data: { eventId: targetEventId, clusterStatus: 'clustered', clusteredAt: new Date() } });
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
    if (source.pushedAt && !target.pushedAt) {
      await tx.event.update({ where: { id: targetEventId }, data: { pushedAt: source.pushedAt } });
    }
    await recalculateEvent(tx, targetEventId);
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
      select: { id: true, publishedAt: true, createdAt: true },
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
      data: { eventId: created.id, clusterStatus: 'clustered', clusteredAt: new Date() },
    });
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
    return created.id;
  });
  if (newEventId) {
    await refreshEventPublicPublication(eventId);
    await refreshEventPublicPublication(newEventId);
    invalidatePublicArticleCache();
  }
  return newEventId;
}
