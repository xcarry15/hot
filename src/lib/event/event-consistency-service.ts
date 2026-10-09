import { db } from '@/lib/db';
import { recalculateEvent } from '@/lib/event/event-recalculation-service';
import { refreshEventPublicPublication, refreshPublicPublication } from '@/lib/public-publication-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import type { Prisma } from '@prisma/client';
import { assertWorkerCanWrite } from '@/lib/execution-write-guard';
import { EVENT_CLUSTER_RULE_VERSION } from '@/contracts/event-clustering';

const EVENT_REPAIR_BATCH_SIZE = 100;
export const EVENT_CONSISTENCY_REPAIR_PHASES = ['attached', 'duplicate-key', 'candidate-review'] as const;
export type EventConsistencyRepairPhase = (typeof EVENT_CONSISTENCY_REPAIR_PHASES)[number];

/**
 * 事件归属的基础事实必须在同一事务内提交；此表记录公开快照刷新失败、
 * 来源删除后的代表恢复或旧版本留下的待修复状态，由独立维护 Job 消费。
 */
type EventDirtyWriter = Pick<Prisma.TransactionClient, 'eventDirty'>;

export async function markEventDirty(
  eventId: string,
  reason: string,
  client: EventDirtyWriter = db,
): Promise<void> {
  if (!eventId) return;
  const now = new Date();
  await client.eventDirty.upsert({
    where: { eventId },
    create: { eventId, reason: reason.slice(0, 500), createdAt: now },
    update: { reason: reason.slice(0, 500), createdAt: now },
  });
}

/** 在来源状态事务中登记受影响的代表事件，不加载全部文章或 Event ID。 */
export async function markSourceRepresentativesDirty(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  sourceId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await client.$executeRaw`
    INSERT INTO event_dirty (id, eventId, reason, createdAt)
    SELECT lower(hex(randomblob(16))), e.id, ${reason.slice(0, 500)}, ${now}
    FROM events e INNER JOIN articles a ON a.id = e.representativeArticleId
    WHERE e.status = 'active' AND a.sourceId = ${sourceId}
    ON CONFLICT(eventId) DO UPDATE SET reason = excluded.reason, createdAt = excluded.createdAt
  `;
}

/** 删除来源时原子撤回不合格代表，后续候选选择交给既有有界修复队列。 */
export async function releaseSourceRepresentatives(
  client: Pick<Prisma.TransactionClient, 'article' | 'event' | '$executeRaw'>,
  sourceId: string,
): Promise<void> {
  const now = new Date();
  await markSourceRepresentativesDirty(client, sourceId, 'source-deleted');
  // 只撤回当前代表的文章投影，不在来源事务内重建该来源的全部文章。
  await client.article.updateMany({
    where: { sourceId, representedEvent: { is: { status: 'active' } } },
    data: {
      publicStatus: 'unpublished', publicPublishedAt: null, publicRevokedAt: null,
      publicPublicationReason: 'not-event-representative',
      publicPublicationEvaluatedAt: now, publicContentUpdatedAt: null,
    },
  });
  const where: Prisma.EventWhereInput = { status: 'active', representativeArticle: { is: { sourceId } } };
  const release = { representativeArticleId: null, representativeManual: false, publicDateKey: '', publicSortAt: null };
  await client.event.updateMany({
    where: { ...where, publicStatus: 'published' },
    data: { ...release, publicStatus: 'revoked', publicRevokedAt: now },
  });
  await client.event.updateMany({ where, data: release });
}

/** 一个修复单元共用提交、执行权与缓存边界，避免阶段各自遗漏收尾。 */
async function runEventRepairTransaction(
  operation: (client: Prisma.TransactionClient) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  await assertWorkerCanWrite(signal);
  const repaired = await db.$transaction(async (tx) => {
    await assertWorkerCanWrite(signal);
    const changed = await operation(tx);
    await assertWorkerCanWrite(signal);
    return changed;
  }, { maxWait: 10_000, timeout: 10_000 });
  if (repaired) invalidatePublicArticleCache();
  return repaired;
}

async function refreshDirtyEvent(eventId: string, signal?: AbortSignal): Promise<boolean> {
  return runEventRepairTransaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (event) {
      await recalculateEvent(tx, eventId);
      await refreshEventPublicPublication(eventId, tx);
    }
    // 同一事务清理已恢复的待办，失败或提交前取消时保留完整恢复边界。
    await tx.eventDirty.deleteMany({ where: { eventId } });
    return Boolean(event);
  }, signal);
}

/** 只修复被明确标记的 Event，避免每分钟扫描整张 Event 表。 */
export async function repairDirtyEvents(limit = EVENT_REPAIR_BATCH_SIZE, signal?: AbortSignal): Promise<number> {
  await assertWorkerCanWrite(signal);
  const rows = await db.eventDirty.findMany({
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
    select: { eventId: true },
  });
  const eventIds = [...new Set(rows.map((row) => row.eventId).filter(Boolean))];
  await assertWorkerCanWrite(signal);
  let repaired = 0;
  for (const eventId of eventIds) {
    try {
      if (await refreshDirtyEvent(eventId, signal)) repaired++;
    } catch (error) {
      await assertWorkerCanWrite(signal);
      console.error(`[event-consistency] dirty Event repair failed event=${eventId}:`, error);
    }
  }
  return repaired;
}

export async function hasDirtyEvents(): Promise<boolean> {
  return (await db.eventDirty.count()) > 0;
}

/**
 * 旧实现曾在归属事务提交后才重算 Event，极端中断时可能留下
 * `eventId != null && clusterStatus = failed`，或尚未完成 AI 就被挂入 Event。
 * 这些状态都不能进入普通流水线，由历史维护任务或单篇失败恢复收敛回基础事实。
 */
export async function repairAttachedClusterArticle(articleId: string, signal?: AbortSignal): Promise<boolean> {
  return runEventRepairTransaction(async (tx) => {
    const article = await tx.article.findUnique({
      where: { id: articleId },
      select: { id: true, eventId: true, clusterStatus: true, aiStatus: true },
    });
    if (!article?.eventId) return false;

    const event = await tx.event.findUnique({
      where: { id: article.eventId },
      select: { id: true, clusterReviewStatus: true },
    });
    if (!event) {
      await tx.article.update({
        where: { id: article.id },
        data: {
          eventId: null,
          clusterStatus: 'pending',
          clusteredAt: null,
          clusterError: null,
          clusterRetryCount: 0,
          nextClusterRetryAt: null,
        },
      });
      await refreshPublicPublication(article.id, tx);
      return true;
    }

    // Event 成员必须先完成 AI。若旧数据或异常人工操作绕过了该前置条件，
    // 解除归属，让它重新进入 AI → 聚类正常流水线，不能伪装成 clustered。
    if (article.aiStatus !== 'done') {
      await tx.article.update({
        where: { id: article.id },
        data: {
          eventId: null,
          clusterStatus: 'pending',
          clusteredAt: null,
          clusterError: null,
          clusterRetryCount: 0,
          nextClusterRetryAt: null,
        },
      });
      await recalculateEvent(tx, event.id);
      await refreshEventPublicPublication(event.id, tx);
      await refreshPublicPublication(article.id, tx);
      return true;
    }

    if (article.clusterStatus === 'failed') {
      await tx.article.update({
        where: { id: article.id },
        data: {
          clusterStatus: event.clusterReviewStatus === 'pending' ? 'needs_review' : 'clustered',
          clusterError: null,
          clusterRetryCount: 0,
          nextClusterRetryAt: null,
        },
      });
    }
    await recalculateEvent(tx, event.id);
    await refreshEventPublicPublication(event.id, tx);
    return true;
  }, signal);
}

export async function repairAttachedClusterFailures(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string, signal?: AbortSignal): Promise<number> {
  await assertWorkerCanWrite(signal);
  const articles = await db.article.findMany({
    where: {
      ...(cursor ? { id: { gt: cursor } } : {}),
      eventId: { not: null },
      OR: [
        { clusterStatus: 'failed' },
        { aiStatus: { not: 'done' } },
      ],
    },
    orderBy: { id: 'asc' },
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
    select: { id: true },
  });
  await assertWorkerCanWrite(signal);
  let repaired = 0;
  for (const article of articles) {
    if (await repairAttachedClusterArticle(article.id, signal)) repaired++;
  }
  return repaired;
}

/**
 * 历史数据可能已经把相同确定性 eventKey 建成多个 confirmed Event。
 * 保留最早 Event 作为待确认的基准，把后续 Event 的同 key 成员降为
 * needs_review；这样旧数据也重新经过公开/推送安全门，而不会继续重复对外释放。
 */
export async function repairDuplicateEventKeyCandidates(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string, signal?: AbortSignal): Promise<number> {
  await assertWorkerCanWrite(signal);
  const rows = await db.article.findMany({
    where: {
      ...(cursor ? { id: { gt: cursor } } : {}),
      eventId: { not: null },
      aiStatus: 'done',
      clusterStatus: 'clustered',
      eventKey: { not: '' },
      event: { is: { status: 'active', clusterReviewStatus: 'confirmed' } },
    },
    select: {
      id: true,
      eventId: true,
      eventKey: true,
      event: { select: { id: true, createdAt: true } },
    },
    orderBy: { id: 'asc' },
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
  });
  await assertWorkerCanWrite(signal);

  const eventKeys = [...new Set(rows.map((row) => row.eventKey).filter(Boolean))];
  const candidateEvents = eventKeys.length === 0
    ? []
    : await db.event.findMany({
      where: {
        status: 'active',
        clusterReviewStatus: 'confirmed',
        articles: { some: { eventKey: { in: eventKeys }, aiStatus: 'done', clusterStatus: 'clustered' } },
      },
      select: {
        id: true,
        createdAt: true,
        articles: {
          where: { eventKey: { in: eventKeys }, aiStatus: 'done', clusterStatus: 'clustered' },
          select: { eventKey: true },
        },
      },
    });
  await assertWorkerCanWrite(signal);
  const byKey = new Map<string, Map<string, { eventId: string; eventCreatedAt: Date }>>();
  for (const event of candidateEvents) {
    for (const article of event.articles) {
      const events = byKey.get(article.eventKey) ?? new Map();
      events.set(event.id, { eventId: event.id, eventCreatedAt: event.createdAt });
      byKey.set(article.eventKey, events);
    }
  }

  const targets: Array<{ eventId: string; eventKey: string; candidateEventId: string }> = [];
  for (const [eventKey, events] of byKey) {
    const ordered = [...events.values()].sort((left, right) => left.eventCreatedAt.getTime() - right.eventCreatedAt.getTime());
    const canonical = ordered[0];
    if (!canonical || ordered.length < 2) continue;
    for (const duplicate of ordered.slice(1)) {
      targets.push({ eventId: duplicate.eventId, eventKey, candidateEventId: canonical.eventId });
    }
  }

  let repaired = 0;
  for (const target of targets.slice(0, Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)))) {
    const changed = await runEventRepairTransaction(async (tx) => {
      const event = await tx.event.findFirst({
        where: { id: target.eventId, status: 'active', clusterReviewStatus: 'confirmed' },
        select: { id: true },
      });
      if (!event) return false;
      const members = await tx.article.findMany({
        where: {
          eventId: target.eventId,
          eventKey: target.eventKey,
          aiStatus: 'done',
          clusterStatus: 'clustered',
        },
        select: { id: true },
      });
      const unresolvedMembers: Array<{ id: string }> = [];
      for (const member of members) {
        const manuallyConfirmed = await tx.eventClusterAudit.findFirst({
          where: {
            articleId: member.id,
            assignedEventId: target.eventId,
            actor: 'admin',
            action: 'confirm_independent',
          },
          select: { id: true },
        });
        if (!manuallyConfirmed) unresolvedMembers.push(member);
      }
      if (unresolvedMembers.length === 0) return false;
      await tx.article.updateMany({
        where: { id: { in: unresolvedMembers.map((member) => member.id) } },
        data: { clusterStatus: 'needs_review', clusterError: null },
      });
      for (const member of unresolvedMembers) {
        const existingAudit = await tx.eventClusterAudit.findFirst({
          where: {
            articleId: member.id,
            assignedEventId: target.eventId,
            candidateEventId: target.candidateEventId,
            action: 'fallback_create',
          },
          select: { id: true },
        });
        if (!existingAudit) {
          await tx.eventClusterAudit.create({
            data: {
              articleId: member.id,
              assignedEventId: target.eventId,
              candidateEventId: target.candidateEventId,
              actor: 'system',
              action: 'fallback_create',
              decisionSource: 'rule',
              confidence: null,
              evidence: JSON.stringify({
                ruleVersion: EVENT_CLUSTER_RULE_VERSION,
                eventKey: target.eventKey,
                selectedCandidateEventId: target.candidateEventId,
                reason: '历史数据存在相同 eventKey 的多个 Event，自动降级为待复核，阻断公开/推送',
              }),
            },
          });
        }
      }
      await recalculateEvent(tx, target.eventId);
      await refreshEventPublicPublication(target.eventId, tx);
      return true;
    }, signal);
    if (!changed) continue;
    repaired++;
  }
  return repaired;
}

/**
 * 旧版本虽已把候选写入审计，却仍把 Article/Event 保持为 confirmed。
 * 将这类仍指向 active 候选 Event 的记录收敛为待复核，避免历史候选继续
 * 绕过公开与推送门禁；已失效候选不再阻断正常数据。
 */
export async function repairPersistedCandidateReviews(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string, signal?: AbortSignal): Promise<number> {
  await assertWorkerCanWrite(signal);
  const audits = await db.eventClusterAudit.findMany({
    where: {
      ...(cursor ? { id: { gt: cursor } } : {}),
      actor: 'system',
      action: { in: ['create', 'fallback_create'] },
      candidateEventId: { not: null },
      assignedEvent: { is: { status: 'active', clusterReviewStatus: 'confirmed' } },
      candidateEvent: { is: { status: 'active' } },
      article: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
    },
    select: { articleId: true, assignedEventId: true, createdAt: true },
    orderBy: { id: 'asc' },
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
  });
  await assertWorkerCanWrite(signal);
  const targets = [...new Map(audits.map((audit) => [
    `${audit.assignedEventId}:${audit.articleId}`,
    audit,
  ])).values()].slice(0, Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)));

  let repaired = 0;
  for (const target of targets) {
    const changed = await runEventRepairTransaction(async (tx) => {
      const article = await tx.article.findFirst({
        where: {
          id: target.articleId,
          eventId: target.assignedEventId,
          aiStatus: 'done',
          clusterStatus: 'clustered',
        },
        select: { id: true },
      });
      const event = await tx.event.findFirst({
        where: { id: target.assignedEventId, status: 'active', clusterReviewStatus: 'confirmed' },
        select: { id: true },
      });
      if (!article || !event) return false;
      const manuallyConfirmed = await tx.eventClusterAudit.findFirst({
        where: {
          articleId: target.articleId,
          assignedEventId: target.assignedEventId,
          actor: 'admin',
          action: 'confirm_independent',
          createdAt: { gt: target.createdAt },
        },
        select: { id: true },
      });
      if (manuallyConfirmed) return false;
      await tx.article.update({
        where: { id: article.id },
        data: { clusterStatus: 'needs_review', clusterError: null },
      });
      await recalculateEvent(tx, event.id);
      await refreshEventPublicPublication(event.id, tx);
      return true;
    }, signal);
    if (!changed) continue;
    repaired++;
  }
  return repaired;
}

async function countConsistencyPage(
  phase: EventConsistencyRepairPhase,
  cursor: string | undefined,
  limit: number,
): Promise<{ ids: string[]; hasMore: boolean }> {
  const take = Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE));
  if (phase === 'attached') {
    const rows = await db.article.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        eventId: { not: null },
        OR: [{ clusterStatus: 'failed' }, { aiStatus: { not: 'done' } }],
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
    return { ids: rows.map((row) => row.id), hasMore: rows.length === take };
  }
  if (phase === 'duplicate-key') {
    const rows = await db.article.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        eventId: { not: null },
        aiStatus: 'done',
        clusterStatus: 'clustered',
        eventKey: { not: '' },
        event: { is: { status: 'active', clusterReviewStatus: 'confirmed' } },
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
    return { ids: rows.map((row) => row.id), hasMore: rows.length === take };
  }
  const rows = await db.eventClusterAudit.findMany({
    where: {
      ...(cursor ? { id: { gt: cursor } } : {}),
      actor: 'system',
      action: { in: ['create', 'fallback_create'] },
      candidateEventId: { not: null },
      assignedEvent: { is: { status: 'active', clusterReviewStatus: 'confirmed' } },
      candidateEvent: { is: { status: 'active' } },
      article: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
    },
    orderBy: { id: 'asc' },
    take,
    select: { id: true },
  });
  return { ids: rows.map((row) => row.id), hasMore: rows.length === take };
}

/**
 * 历史一致性修复的单页入口。每次只读取一个有序 ID 窗口，调用方把
 * phase/cursor 写入 Maintenance Job payload，避免恢复时重新全表加载。
 */
export async function repairEventConsistencyPage(
  phase: EventConsistencyRepairPhase,
  cursor?: string,
  limit = EVENT_REPAIR_BATCH_SIZE,
  signal?: AbortSignal,
): Promise<{ repaired: number; nextCursor: string | null; done: boolean }> {
  await assertWorkerCanWrite(signal);
  const page = await countConsistencyPage(phase, cursor, limit);
  await assertWorkerCanWrite(signal);
  if (page.ids.length === 0) {
    return { repaired: 0, nextCursor: null, done: true };
  }
  let repaired = 0;
  if (phase === 'attached') repaired = await repairAttachedClusterFailures(limit, cursor, signal);
  if (phase === 'duplicate-key') repaired = await repairDuplicateEventKeyCandidates(limit, cursor, signal);
  if (phase === 'candidate-review') repaired = await repairPersistedCandidateReviews(limit, cursor, signal);
  await assertWorkerCanWrite(signal);
  return {
    repaired,
    nextCursor: page.ids[page.ids.length - 1] ?? null,
    done: !page.hasMore,
  };
}
