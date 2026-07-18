import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getPushTargetStatesForEvents } from '@/lib/push/delivery';

export type TechnicalIssue = 'process_failed' | 'cluster_failed' | 'ai_failed' | 'push_failed';

export interface TechnicalWorkItem {
  articleId: string;
  issues: TechnicalIssue[];
  retryAvailableAt: string | null;
}

const articleFailureWhere: Prisma.ArticleWhereInput = { OR: [
  { fetchStatus: 'failed' },
  { clusterStatus: 'failed' },
  { aiStatus: 'failed' },
  { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
] };

export async function getTechnicalWorkQueue(): Promise<TechnicalWorkItem[]> {
  const [articles, events] = await Promise.all([
    db.article.findMany({
      where: articleFailureWhere,
      select: { id: true, fetchStatus: true, clusterStatus: true, aiStatus: true, skipReason: true, nextClusterRetryAt: true, nextAiRetryAt: true },
    }),
    db.event.findMany({
      where: { status: 'active', representativeArticleId: { not: null } },
      select: { id: true, representativeArticleId: true, nextPushRetryAt: true },
    }),
  ]);
  const items = new Map<string, TechnicalWorkItem>();
  for (const article of articles) {
    const issues: TechnicalIssue[] = [];
    if (article.fetchStatus === 'failed') issues.push('process_failed');
    if (article.clusterStatus === 'failed') issues.push('cluster_failed');
    if (article.aiStatus === 'failed' || (article.aiStatus === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))) issues.push('ai_failed');
    const retryDates = [article.nextClusterRetryAt, article.nextAiRetryAt].filter((value): value is Date => Boolean(value));
    items.set(article.id, {
      articleId: article.id,
      issues,
      retryAvailableAt: retryDates.length > 0 ? new Date(Math.max(...retryDates.map((date) => date.getTime()))).toISOString() : null,
    });
  }
  const targetStatesByEvent = await getPushTargetStatesForEvents(events.map((event) => event.id));
  for (const event of events) {
    if (!event.representativeArticleId) continue;
    const hasFailure = (targetStatesByEvent.get(event.id) ?? []).some((target) => target.latestStatus === 'failure');
    if (!hasFailure) continue;
    const existing = items.get(event.representativeArticleId) ?? { articleId: event.representativeArticleId, issues: [], retryAvailableAt: null };
    if (!existing.issues.includes('push_failed')) existing.issues.push('push_failed');
    existing.retryAvailableAt = event.nextPushRetryAt?.toISOString() ?? existing.retryAvailableAt;
    items.set(existing.articleId, existing);
  }
  return [...items.values()];
}
