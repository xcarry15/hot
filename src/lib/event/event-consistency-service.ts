import { db } from '@/lib/db';
import { recalculateEventById } from '@/lib/event/event-recalculation-service';
import { recalculateEvent } from '@/lib/event/event-recalculation-service';
import { refreshEventPublicPublication } from '@/lib/public-publication-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import type { Prisma } from '@prisma/client';
import { assertNotAborted } from '@/lib/worker-stop';

const EVENT_REPAIR_BATCH_SIZE = 100;
export const EVENT_CONSISTENCY_REPAIR_PHASES = ['attached', 'duplicate-key', 'candidate-review'] as const;
export type EventConsistencyRepairPhase = (typeof EVENT_CONSISTENCY_REPAIR_PHASES)[number];

export interface ConsistencyViolation {
  eventId: string;
  issue: string;
  severity: 'error' | 'warning';
}
/**
 * 事件归属的基础事实必须在同一事务内提交；此表只记录事务后公开快照刷新失败、
 * 或旧版本留下的待修复状态，供受控的后台恢复使用。
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

async function refreshDirtyEvent(eventId: string): Promise<boolean> {
  const event = await db.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) {
    await db.eventDirty.deleteMany({ where: { eventId } });
    return false;
  }
  await recalculateEventById(eventId);
  await db.eventDirty.deleteMany({ where: { eventId } });
  return true;
}

/** 只修复被明确标记的 Event，避免每分钟扫描整张 Event 表。 */
export async function repairDirtyEvents(limit = EVENT_REPAIR_BATCH_SIZE, signal?: AbortSignal): Promise<number> {
  assertNotAborted(signal);
  const rows = await db.eventDirty.findMany({
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
    select: { eventId: true },
  });
  const eventIds = [...new Set(rows.map((row) => row.eventId).filter(Boolean))];
  let repaired = 0;
  for (const eventId of eventIds) {
    try {
      assertNotAborted(signal);
      if (await refreshDirtyEvent(eventId)) repaired++;
    } catch (error) {
      if (signal?.aborted) throw error;
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
 * 这些状态都不能进入普通流水线，因此在批处理开始时主动收敛回基础事实。
 */
export async function repairAttachedClusterArticle(articleId: string): Promise<boolean> {
  const result = await db.$transaction(async (tx) => {
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
    return true;
  });
  return result;
}

export async function repairAttachedClusterFailures(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string): Promise<number> {
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
  let repaired = 0;
  for (const article of articles) {
    try {
      if (await repairAttachedClusterArticle(article.id)) repaired++;
    } catch (error) {
      console.error(`[event-consistency] attached Article repair failed article=${article.id}:`, error);
    }
  }
  return repaired;
}

/**
 * 历史数据可能已经把相同确定性 eventKey 建成多个 confirmed Event。
 * 保留最早 Event 作为待确认的基准，把后续 Event 的同 key 成员降为
 * needs_review；这样旧数据也重新经过公开/推送安全门，而不会继续重复对外释放。
 */
export async function repairDuplicateEventKeyCandidates(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string): Promise<number> {
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
    const changed = await db.$transaction(async (tx) => {
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
                ruleVersion: 'event-cluster-v11',
                eventKey: target.eventKey,
                selectedCandidateEventId: target.candidateEventId,
                reason: '历史数据存在相同 eventKey 的多个 Event，自动降级为待复核，阻断公开/推送',
              }),
            },
          });
        }
      }
      await recalculateEvent(tx, target.eventId);
      return true;
    });
    if (!changed) continue;
    repaired++;
    try {
      await refreshEventPublicPublication(target.eventId);
    } catch (error) {
      console.error(`[event-consistency] duplicate eventKey publication repair failed event=${target.eventId}:`, error);
      await markEventDirty(target.eventId, `duplicate-event-key-publication-repair: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (repaired > 0) invalidatePublicArticleCache();
  return repaired;
}

/**
 * 旧版本虽已把候选写入审计，却仍把 Article/Event 保持为 confirmed。
 * 将这类仍指向 active 候选 Event 的记录收敛为待复核，避免历史候选继续
 * 绕过公开与推送门禁；已失效候选不再阻断正常数据。
 */
export async function repairPersistedCandidateReviews(limit = EVENT_REPAIR_BATCH_SIZE, cursor?: string): Promise<number> {
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
  const targets = [...new Map(audits.map((audit) => [
    `${audit.assignedEventId}:${audit.articleId}`,
    audit,
  ])).values()].slice(0, Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)));

  let repaired = 0;
  const refreshed = new Set<string>();
  for (const target of targets) {
    const changed = await db.$transaction(async (tx) => {
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
      return true;
    });
    if (!changed) continue;
    repaired++;
    refreshed.add(target.assignedEventId);
  }
  for (const eventId of refreshed) {
    try {
      await refreshEventPublicPublication(eventId);
    } catch (error) {
      console.error(`[event-consistency] persisted candidate publication repair failed event=${eventId}:`, error);
      await markEventDirty(eventId, `persisted-candidate-publication-repair: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (refreshed.size > 0) invalidatePublicArticleCache();
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
  assertNotAborted(signal);
  const page = await countConsistencyPage(phase, cursor, limit);
  if (page.ids.length === 0) {
    return { repaired: 0, nextCursor: null, done: true };
  }
  let repaired = 0;
  if (phase === 'attached') repaired = await repairAttachedClusterFailures(limit, cursor);
  if (phase === 'duplicate-key') repaired = await repairDuplicateEventKeyCandidates(limit, cursor);
  if (phase === 'candidate-review') repaired = await repairPersistedCandidateReviews(limit, cursor);
  return {
    repaired,
    nextCursor: page.ids[page.ids.length - 1] ?? null,
    done: !page.hasMore,
  };
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
