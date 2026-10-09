import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { isRepresentativeEligible as isReleaseRepresentativeEligible } from '@/lib/event-release-policy';
import { eventDate } from '@/lib/event/event-representative';
import {
  recalculateEvent,
  releaseRepresentativeOwnership,
} from '@/lib/event/event-recalculation-service';
import type { Prisma } from '@prisma/client';
export {
  deriveEventClusterReviewStatus,
  selectRepresentativeCandidate,
  sharedBrands,
  type RepresentativeCandidate,
} from '@/lib/event/event-representative';
export { getSameBrandCandidates, searchActiveEvents } from '@/lib/event/event-query-service';
export { getEventArticles } from '@/lib/event/event-query-service';
export {
  recalculateEventsInTransaction,
  reconcileEventAfterArticleDeletionInTransaction,
  type ArticleDeletionEventResult,
} from '@/lib/event/event-recalculation-service';

const EVENT_MUTATION_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

async function refreshEventRepresentatives(client: Prisma.TransactionClient, eventIds: string[]): Promise<void> {
  for (const eventId of [...new Set(eventIds)]) await refreshEventPublicPublication(eventId, client);
}

export async function confirmIndependentArticle(eventId: string, articleId: string): Promise<boolean> {
  const updated = await db.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { status: true, clusterReviewStatus: true, _count: { select: { articles: true } } },
    });
    // “确认独立事件”只适用于系统单独建立的单篇待复核 Event。
    // 多成员 Event 必须通过拆分/移动明确表达人工归属，不能悄悄把一篇成员标成已确认。
    if (event?.status !== 'active' || event.clusterReviewStatus !== 'pending' || event._count.articles !== 1) return false;
    const article = await tx.article.findFirst({
      where: { id: articleId, eventId, aiStatus: 'done', clusterStatus: 'needs_review' },
      select: { id: true },
    });
    if (!article) return false;
    await tx.article.update({
      where: { id: articleId },
      data: { clusterStatus: 'clustered', clusteredAt: new Date(), clusterError: null, skipReason: null },
    });
    await recalculateEvent(tx, eventId);
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: eventId,
        actor: 'admin',
        action: 'confirm_independent',
        decisionSource: 'admin',
        confidence: null,
        evidence: JSON.stringify({ eventId }),
      },
    });
    await refreshEventRepresentatives(tx, [eventId]);
    return true;
  }, EVENT_MUTATION_TRANSACTION_OPTIONS);
  if (updated) invalidatePublicArticleCache();
  return updated;
}

export async function moveArticleToEvent(sourceEventId: string, articleId: string, targetEventId: string): Promise<boolean> {
  // 移动同时更新文章、重算源和目标 Event、同步公开投影及审计。
  // SQLite 响应变慢或写入等待时，这些查询可能超过 Prisma 默认的 5 秒交互事务上限，
  // 导致 P2028 并回滚整次移动；给这段必须原子提交的操作留出合理等待时间。
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
    // P1-7: Event 成员必须先完成 AI，不能通过人工移动绕过技术门禁。
    if (article.aiStatus !== 'done') return null;
    await tx.article.update({
      where: { id: articleId },
      data: {
        eventId: targetEventId,
        clusterStatus: 'clustered',
        clusteredAt: new Date(),
        clusterError: null,
      },
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
        confidence: null,
        evidence: JSON.stringify({
          sourceEventId,
          targetEventId,
          articleEventKey: article.eventKey,
        }),
      },
    });
    await refreshEventRepresentatives(tx, [sourceEventId, targetEventId]);
    return true;
  }, EVENT_MUTATION_TRANSACTION_OPTIONS);
  if (!result) return false;
  invalidatePublicArticleCache();
  return true;
}

export async function setEventRepresentative(eventId: string, articleId: string): Promise<boolean> {
  const updated = await db.$transaction(async (tx) => {
    // Membership and eligibility must be read in the same transaction as the
    // pointer update. Otherwise a concurrent move can make the Event point at
    // an article that no longer belongs to it.
    const [event, member] = await Promise.all([
      tx.event.findUnique({ where: { id: eventId }, select: { status: true, clusterReviewStatus: true } }),
      tx.article.findFirst({
        where: { id: articleId, eventId },
        select: {
          id: true, clusterStatus: true, aiStatus: true, score: true, relevance: true,
          cleanContent: true, publishedAt: true, createdAt: true,
          source: { select: { publicEnabled: true, deletedAt: true } },
        },
      }),
    ]);
    if (event?.status !== 'active' || event.clusterReviewStatus !== 'confirmed' || !member || !isReleaseRepresentativeEligible(member)) return false;
    await releaseRepresentativeOwnership(tx, eventId, articleId);
    // 用关系条件把“仍属于该 Event”绑定到指针写入本身；若文章在读取后
    // 被移动，updateMany 不会更新代表指针，整个事务也会回滚。
    const pointerUpdate = await tx.event.updateMany({
      where: {
        id: eventId,
        status: 'active',
        clusterReviewStatus: 'confirmed',
        articles: {
          some: {
            id: articleId,
            clusterStatus: 'clustered',
            aiStatus: 'done',
            source: { is: { deletedAt: null } },
          },
        },
      },
      data: { representativeArticleId: articleId, representativeManual: true },
    });
    if (pointerUpdate.count !== 1) return false;
    await tx.eventClusterAudit.create({
      data: {
        articleId,
        assignedEventId: eventId,
        actor: 'admin',
        action: 'representative_change',
        decisionSource: 'admin',
        confidence: null,
        evidence: JSON.stringify({ representativeArticleId: articleId }),
      },
    });
    await refreshEventRepresentatives(tx, [eventId]);
    return true;
  }, EVENT_MUTATION_TRANSACTION_OPTIONS);
  if (!updated) return false;
  invalidatePublicArticleCache();
  return true;
}

export async function mergeEvents(sourceEventId: string, targetEventId: string): Promise<boolean> {
  if (!sourceEventId || !targetEventId || sourceEventId === targetEventId) return false;
  const result = await db.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.event.findUnique({ where: { id: sourceEventId }, select: { id: true, status: true, pushedAt: true, articles: { select: { id: true, aiStatus: true } } } }),
      tx.event.findUnique({ where: { id: targetEventId }, select: { id: true, status: true, pushedAt: true, articles: { select: { aiStatus: true } } } }),
    ]);
    if (!source || !target || source.status !== 'active' || target.status !== 'active') return false;
    if (source.articles.some((article) => article.aiStatus !== 'done')
      || target.articles.some((article) => article.aiStatus !== 'done')) return false;
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
          confidence: null,
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
    await refreshEventRepresentatives(tx, [targetEventId]);
    return true;
  }, EVENT_MUTATION_TRANSACTION_OPTIONS);
  if (result) {
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
    // P1-7: 拆分也不能把未完成 AI 的文章挂入新 Event。
    if (articles.some((article) => article.aiStatus !== 'done')) return null;
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
    // 人工拆分即确认新的 Event 归属；此处所有文章都已完成 AI。
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
          confidence: null,
          evidence: JSON.stringify({ sourceEventId: eventId, newEventId: created.id }),
        },
      });
    }
    await refreshEventRepresentatives(tx, [eventId, created.id]);
    return created.id;
  }, EVENT_MUTATION_TRANSACTION_OPTIONS);
  if (newEventId) {
    invalidatePublicArticleCache();
  }
  return newEventId;
}
