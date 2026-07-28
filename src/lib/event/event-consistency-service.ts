import { db } from '@/lib/db';
import { recalculateEventById } from '@/lib/event/event-recalculation-service';
import { recalculateEvent } from '@/lib/event/event-recalculation-service';
import type { Prisma } from '@prisma/client';

const EVENT_REPAIR_BATCH_SIZE = 100;

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
export async function repairDirtyEvents(limit = EVENT_REPAIR_BATCH_SIZE): Promise<number> {
  const rows = await db.eventDirty.findMany({
    take: Math.max(1, Math.min(limit, EVENT_REPAIR_BATCH_SIZE)),
    select: { eventId: true },
  });
  const eventIds = [...new Set(rows.map((row) => row.eventId).filter(Boolean))];
  let repaired = 0;
  for (const eventId of eventIds) {
    try {
      if (await refreshDirtyEvent(eventId)) repaired++;
    } catch (error) {
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
 * `eventId != null && clusterStatus = failed`。该状态不能进入普通聚类队列，
 * 因此在批处理开始时主动收敛回 Event 的实际状态。
 */
export async function repairAttachedClusterArticle(articleId: string): Promise<boolean> {
  const result = await db.$transaction(async (tx) => {
    const article = await tx.article.findUnique({
      where: { id: articleId },
      select: { id: true, eventId: true, clusterStatus: true },
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
          clusterError: null,
          nextClusterRetryAt: null,
        },
      });
      return false;
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

export async function repairAttachedClusterFailures(limit = EVENT_REPAIR_BATCH_SIZE): Promise<number> {
  const articles = await db.article.findMany({
    where: { eventId: { not: null }, clusterStatus: 'failed' },
    orderBy: { updatedAt: 'asc' },
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
  let repairs = await repairAttachedClusterFailures();

  // 优先消费显式脏记录；正常运行不再做全表重算。
  repairs += await repairDirtyEvents();

  // 管理员手动触发的全量一致性校验仍保留，用于诊断历史残留。
  const events = await db.event.findMany({
    where: { status: 'active' },
    select: { id: true },
  });
  for (const { id } of events) {
    await recalculateEventById(id);
    repairs++;
  }

  return repairs;
}
