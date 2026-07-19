import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getPushTargetStatesForEvents } from '@/lib/push/delivery';

export type TechnicalIssue = 'process_failed' | 'cluster_failed' | 'ai_failed' | 'push_failed';

export interface TechnicalWorkItem {
  articleId: string;
  issues: TechnicalIssue[];
  retryAvailableAt: string | null;
  state: 'auto_retry' | 'manual';
}

const articleFailureWhere: Prisma.ArticleWhereInput = {
  technicalIgnoredAt: null,
  OR: [
    { fetchStatus: 'failed' },
    { clusterStatus: 'failed' },
    { aiStatus: 'failed' },
    { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
  ],
};

const TECHNICAL_QUEUE_TTL_MS = 5_000;
let technicalQueueCache: { expiresAt: number; value: Promise<TechnicalWorkItem[]> } | null = null;

export function invalidateTechnicalWorkQueueCache(): void {
  technicalQueueCache = null;
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
      where: { status: 'active', representativeArticleId: { not: null } },
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
    if (article.clusterStatus === 'failed') {
      issues.push('cluster_failed');
      if (article.nextClusterRetryAt) retryDates.push(article.nextClusterRetryAt);
      else requiresManual = true;
    }
    if (article.aiStatus === 'failed' || (article.aiStatus === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))) {
      issues.push('ai_failed');
      if (article.nextAiRetryAt) retryDates.push(article.nextAiRetryAt);
      else requiresManual = true;
    }
    items.set(article.id, {
      articleId: article.id,
      issues,
      retryAvailableAt: retryDates.length > 0 ? new Date(Math.max(...retryDates.map((date) => date.getTime()))).toISOString() : null,
      state: requiresManual ? 'manual' : 'auto_retry',
    });
  }
  const targetStatesByEvent = await getPushTargetStatesForEvents(events.map((event) => event.id));
  for (const event of events) {
    if (!event.representativeArticleId || event.representativeArticle?.technicalIgnoredAt) continue;
    const hasFailure = (targetStatesByEvent.get(event.id) ?? []).some((target) => target.latestStatus === 'failure');
    if (!hasFailure) continue;
    const existing = items.get(event.representativeArticleId) ?? { articleId: event.representativeArticleId, issues: [], retryAvailableAt: null, state: event.nextPushRetryAt ? 'auto_retry' : 'manual' };
    if (!existing.issues.includes('push_failed')) existing.issues.push('push_failed');
    existing.retryAvailableAt = event.nextPushRetryAt?.toISOString() ?? existing.retryAvailableAt;
    if (!event.nextPushRetryAt) existing.state = 'manual';
    items.set(existing.articleId, existing);
  }
  return [...items.values()];
}
