import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { isRepresentativeEligible as isReleaseRepresentativeEligible } from '@/lib/event-release-policy';
import {
  deriveEventClusterReviewStatus,
  eventDate,
  selectRepresentativeCandidate,
} from '@/lib/event/event-representative';

type EventTransaction = Prisma.TransactionClient;

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
        id: true, clusterStatus: true, aiStatus: true, score: true, relevance: true,
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

/**
 * representativeArticleId 是跨 Event 唯一的所有权指针。
 * 文章移动/拆分或并发重算期间，旧 Event 可能短暂保留旧指针；
 * 设置新代表前先释放其他 Event 的过期占用，避免 P2002 阻断整批聚类。
 */
export async function releaseRepresentativeOwnership(
  client: EventTransaction,
  eventId: string,
  articleId: string,
): Promise<void> {
  await client.event.updateMany({
    where: {
      representativeArticleId: articleId,
      id: { not: eventId },
    },
    data: {
      representativeArticleId: null,
      representativeManual: false,
    },
  });
}

export async function recalculateEvent(client: EventTransaction, eventId: string): Promise<void> {
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
  if (representative.id) {
    await releaseRepresentativeOwnership(client, eventId, representative.id);
  }
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

/**
 * 修复历史或异常并发留下的代表文章指针：
 * Event 的 representativeArticleId 必须指向自身 articles 中的成员。
 * 在聚类批处理前执行一次，避免旧指针与新聚类结果争抢唯一约束。
 */
export async function repairStaleEventRepresentatives(): Promise<number> {
  const eventIds = await db.$transaction(async (tx) => {
    const rows = await tx.event.findMany({
      where: { representativeArticleId: { not: null } },
      select: {
        id: true,
        representativeArticleId: true,
        representativeArticle: { select: { eventId: true } },
      },
    });
    const staleIds = rows
      .filter((event) => event.representativeArticle?.eventId !== event.id)
      .map((event) => event.id);
    if (staleIds.length === 0) return [];

    // 先统一释放，再按当前成员重新选择，避免修复顺序之间互相触发唯一约束。
    await tx.event.updateMany({
      where: { id: { in: staleIds } },
      data: { representativeArticleId: null, representativeManual: false },
    });
    for (const staleId of staleIds) {
      await recalculateEvent(tx, staleId);
    }
    return staleIds;
  });

  if (eventIds.length > 0) {
    await Promise.all(eventIds.map((eventId) => refreshEventPublicPublication(eventId)));
    invalidatePublicArticleCache();
  }
  return eventIds.length;
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
