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
    return true;
  });
  if (updated) await refreshEventRepresentatives([eventId]);
  return updated;
}

/**
 * 旧版本会把单篇、多主题或缺少事件身份的文章留下为待复核 Event。
 * 单篇 Event 没有可比较的成员，系统可以安全地按独立事件确认，避免历史数据
 * 永久占据人工队列；真正包含多个成员的待复核 Event 仍保留人工校准入口。
 */
export async function autoConfirmSingleArticleReviewEvents(): Promise<number> {
  const candidates = await db.event.findMany({
    where: { status: 'active', clusterReviewStatus: 'pending' },
    select: {
      id: true,
      articles: { select: { id: true, aiStatus: true, clusterStatus: true } },
      assignedAudits: {
        where: {
          candidateEventId: { not: null },
          candidateEvent: { is: { status: 'active' } },
        },
        select: { id: true },
        take: 1,
      },
    },
  });
  let confirmed = 0;
  for (const candidate of candidates) {
    const article = candidate.articles[0];
    if (candidate.articles.length !== 1 || !article || article.aiStatus !== 'done' || article.clusterStatus !== 'needs_review') continue;
    // 候选关系导致的单篇待复核 Event 不能自动确认，否则会再次绕过
    // 公开/推送安全门。只有没有候选 Event 的历史单篇 review 才能自动收口。
    if (candidate.assignedAudits.length > 0) continue;
    const updated = await db.$transaction(async (tx) => {
      const current = await tx.article.findFirst({
        where: { id: article.id, eventId: candidate.id, aiStatus: 'done', clusterStatus: 'needs_review' },
        select: { id: true },
      });
      if (!current) return false;
      await tx.article.update({
        where: { id: article.id },
        data: { clusterStatus: 'clustered', clusteredAt: new Date(), clusterError: null, skipReason: null },
      });
      await recalculateEvent(tx, candidate.id);
      await tx.eventClusterAudit.create({
        data: {
          articleId: article.id,
          assignedEventId: candidate.id,
          actor: 'system',
          action: 'confirm_independent',
          decisionSource: 'rule',
          confidence: null,
          evidence: JSON.stringify({
            automatic: true,
            reason: '单篇待复核 Event 没有其他成员，自动按独立事件确认',
          }),
        },
      });
      return true;
    });
    if (!updated) continue;
    confirmed++;
    await refreshEventRepresentatives([candidate.id]);
  }
  return confirmed;
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
        confidence: null,
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
        confidence: null,
        evidence: JSON.stringify({ representativeArticleId: articleId }),
      },
    });
    return true;
  });
  if (!updated) return false;
  await refreshEventPublicPublication(eventId);
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
