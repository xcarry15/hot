import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getPushTargetStatesForEvents } from '@/lib/push/delivery';
import { isAiRetryWaiting, isTechnicalAiFailure } from '@/contracts/workflow';

export type TechnicalIssue = 'process_failed' | 'ai_failed' | 'ai_waiting' | 'cluster_failed' | 'push_failed';

export interface TechnicalWorkItem {
  articleId: string;
  issues: TechnicalIssue[];
  retryAvailableAt: string | null;
  state: 'auto_retry' | 'waiting' | 'manual';
}

const articleFailureWhere: Prisma.ArticleWhereInput = {
  technicalIgnoredAt: null,
  source: { is: { enabled: true, deletedAt: null } },
  OR: [
    { fetchStatus: 'failed' },
    { clusterStatus: 'failed' },
    { aiStatus: 'failed' },
    { aiStatus: 'pending', nextAiRetryAt: { not: null } },
    { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
  ],
};

const TECHNICAL_QUEUE_TTL_MS = 5_000;
let technicalQueueCache: { expiresAt: number; value: Promise<TechnicalWorkItem[]> } | null = null;

export function invalidateTechnicalWorkQueueCache(): void {
  technicalQueueCache = null;
}

/**
 * 判断是否存在已经到达重试时间的技术失败文章。
 *
 * 该查询只服务于后台恢复调度，不包含来源采集失败：采集失败没有现成
 * Article 可处理，仍由下一次正常采集或人工采集触发。到达最大重试次数
 * 后 next*RetryAt 会被清空，因此自然转为人工处理，不会被自动任务反复捞取。
 */
export async function hasDueTechnicalRecovery(now = new Date()): Promise<boolean> {
  const article = await db.article.findFirst({
    where: {
      technicalIgnoredAt: null,
      source: { is: { enabled: true, deletedAt: null } },
      OR: [
        { fetchStatus: 'failed', nextFetchRetryAt: { lte: now } },
        { aiStatus: 'failed', nextAiRetryAt: { lte: now } },
        { aiStatus: 'pending', nextAiRetryAt: { lte: now } },
        { clusterStatus: 'failed', nextClusterRetryAt: { lte: now } },
      ],
    },
    select: { id: true },
  });
  return Boolean(article);
}

export async function getTechnicalWorkQueue(): Promise<TechnicalWorkItem[]> {
  if (technicalQueueCache && technicalQueueCache.expiresAt > Date.now()) {
    return technicalQueueCache.value;
  }
  const value = buildTechnicalWorkQueue();
  technicalQueueCache = { expiresAt: Date.now() + TECHNICAL_QUEUE_TTL_MS, value };
  void value.catch(() => {
    if (technicalQueueCache?.value === value) technicalQueueCache = null;
  });
  return value;
}

async function buildTechnicalWorkQueue(): Promise<TechnicalWorkItem[]> {
  const [articles, events] = await Promise.all([
    db.article.findMany({
      where: articleFailureWhere,
      select: { id: true, fetchStatus: true, nextFetchRetryAt: true, clusterStatus: true, aiStatus: true, skipReason: true, nextClusterRetryAt: true, nextAiRetryAt: true },
    }),
    db.event.findMany({
      where: {
        status: 'active',
        representativeArticleId: { not: null },
        representativeArticle: { is: { source: { is: { enabled: true, deletedAt: null } } } },
      },
      select: { id: true, representativeArticleId: true, nextPushRetryAt: true, representativeArticle: { select: { technicalIgnoredAt: true } } },
    }),
  ]);
  const items = new Map<string, TechnicalWorkItem>();
  for (const article of articles) {
    const issues: TechnicalIssue[] = [];
    const retryDates: Date[] = [];
    let requiresManual = false;
    if (article.fetchStatus === 'failed') {
      issues.push('process_failed');
      if (article.nextFetchRetryAt) retryDates.push(article.nextFetchRetryAt);
      else requiresManual = true;
    }
    if (isTechnicalAiFailure(article)) {
      issues.push('ai_failed');
      if (article.nextAiRetryAt) retryDates.push(article.nextAiRetryAt);
      else requiresManual = true;
    }
    if (isAiRetryWaiting(article)) {
      issues.push('ai_waiting');
      if (article.nextAiRetryAt) retryDates.push(article.nextAiRetryAt);
    }
    if (article.clusterStatus === 'failed') {
      issues.push('cluster_failed');
      if (article.nextClusterRetryAt) retryDates.push(article.nextClusterRetryAt);
      else requiresManual = true;
    }
    items.set(article.id, {
      articleId: article.id,
      issues,
      retryAvailableAt: retryDates.length > 0 ? new Date(Math.max(...retryDates.map((date) => date.getTime()))).toISOString() : null,
      state: requiresManual ? 'manual' : issues.includes('ai_waiting') ? 'waiting' : 'auto_retry',
    });
  }
  const targetStatesByEvent = await getPushTargetStatesForEvents(events.map((event) => event.id));
  for (const event of events) {
    if (!event.representativeArticleId || event.representativeArticle?.technicalIgnoredAt) continue;
    const targetStates = targetStatesByEvent.get(event.id) ?? [];
    const hasUnknown = targetStates.some((target) => target.latestStatus === 'unknown');
    const hasFailure = targetStates.some((target) => target.latestStatus === 'failure' || target.latestStatus === 'unknown');
    if (!hasFailure) continue;
    const existing = items.get(event.representativeArticleId) ?? { articleId: event.representativeArticleId, issues: [], retryAvailableAt: null, state: event.nextPushRetryAt ? 'auto_retry' : 'manual' };
    if (!existing.issues.includes('push_failed')) existing.issues.push('push_failed');
    existing.retryAvailableAt = event.nextPushRetryAt?.toISOString() ?? existing.retryAvailableAt;
    // unknown 表示“可能已经投递成功”，任何自动重试都有重复投递风险；
    // 即使旧的 nextPushRetryAt 仍存在，也必须转人工确认。
    if (hasUnknown || !event.nextPushRetryAt) existing.state = 'manual';
    items.set(existing.articleId, existing);
  }
  return [...items.values()];
}
