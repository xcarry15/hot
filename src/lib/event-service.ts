import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { isRepresentativeEligible as isReleaseRepresentativeEligible } from '@/lib/event-release-policy';
import { eventDate } from '@/lib/event/event-representative';
import {
  recalculateEvent,
  releaseRepresentativeOwnership,
} from '@/lib/event/event-recalculation-service';
import { markEventDirty } from '@/lib/event/event-consistency-service';
export {
  deriveEventClusterReviewStatus,
  isRepresentativeEligible,
  selectRepresentativeCandidate,
  sharedBrands,
  type RepresentativeCandidate,
} from '@/lib/event/event-representative';
export { getSameBrandCandidates, searchActiveEvents } from '@/lib/event/event-query-service';
export { getEventArticles } from '@/lib/event/event-query-service';
export {
  recalculateArticleEvent,
  recalculateEventById,
  recalculateEventsInTransaction,
  reconcileEventAfterArticleDeletion,
  reconcileEventAfterArticleDeletionInTransaction,
  repairStaleEventRepresentatives,
  type ArticleDeletionEventResult,
} from '@/lib/event/event-recalculation-service';
export {
  autoRepairEventConsistency,
  scanEventConsistency,
  type ConsistencyViolation,
} from '@/lib/event/event-consistency-service';

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

export async function moveArticleToEvent(sourceEventId: string, articleId: string, targetEventId: string): Promise<boolean> {
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
    if (article?.eventId !== sourceEventId || sourceEventId === targetEventId || target?.status !== 'active') return null;
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
    await markEventDirty(sourceEventId, `article ${articleId} moved out to ${targetEventId}`, tx);
    await markEventDirty(targetEventId, `article ${articleId} moved in from ${sourceEventId}`, tx);
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

export async function setEventRepresentative(eventId: string, articleId: string): Promise<boolean> {
  const [event, member] = await Promise.all([
    db.event.findUnique({ where: { id: eventId }, select: { status: true, clusterReviewStatus: true } }),
    db.article.findFirst({
      where: { id: articleId, eventId },
      select: {
        id: true, clusterStatus: true, aiStatus: true, score: true, relevance: true,
        cleanContent: true, publishedAt: true, createdAt: true,
        source: { select: { publicEnabled: true, deletedAt: true } },
      },
    }),
  ]);
  if (event?.status !== 'active' || event.clusterReviewStatus !== 'confirmed' || !member || !isReleaseRepresentativeEligible(member)) return false;
  await db.$transaction(async (tx) => {
    await releaseRepresentativeOwnership(tx, eventId, articleId);
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
    await markEventDirty(targetEventId, `merged from ${sourceEventId}`, tx);
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
    // 先重算源 Event，释放被拆出的代表文章，再重算新 Event。
    await recalculateEvent(tx, eventId);
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
    await markEventDirty(created.id, `split from ${eventId}`, tx);
    await markEventDirty(eventId, `split to ${created.id}`, tx);
    return created.id;
  });
  if (newEventId) {
    await refreshEventPublicPublication(eventId);
    await refreshEventPublicPublication(newEventId);
    invalidatePublicArticleCache();
  }
  return newEventId;
}
