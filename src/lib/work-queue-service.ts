import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getWebhookConfigs } from '@/lib/settings';

export async function getWorkQueueSummary() {
  const technicalWhere: Prisma.ArticleWhereInput = { OR: [
    { fetchStatus: 'failed' as const },
    { clusterStatus: 'failed' },
    { aiStatus: 'failed' },
    { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
  ] };
  const humanWhere: Prisma.ArticleWhereInput = { OR: [
    { clusterStatus: 'needs_review' },
    { reviewStatus: 'unreviewed' },
    { aiStatus: 'done', aiConfidence: { lt: 70 } },
  ] };
  const [technicalArticles, failedSources, processFailed, clusterFailed, aiFailed, humanArticles, clusterReview, unreviewed, lowConfidence, webhookConfigs] = await Promise.all([
    db.article.findMany({ where: technicalWhere, select: { id: true } }),
    db.source.count({ where: { deletedAt: null, OR: [{ status: 'warning' }, { status: 'breaker' }] } }),
    db.article.count({ where: { fetchStatus: 'failed' } }),
    db.article.count({ where: { clusterStatus: 'failed' } }),
    db.article.count({ where: { OR: [{ aiStatus: 'failed' }, { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } }] } }),
    db.article.findMany({ where: humanWhere, select: { id: true } }),
    db.article.count({ where: { clusterStatus: 'needs_review' } }),
    db.article.count({ where: { reviewStatus: 'unreviewed' } }),
    db.article.count({ where: { aiStatus: 'done', aiConfidence: { lt: 70 } } }),
    getWebhookConfigs(),
  ]);
  const enabledUrls = webhookConfigs.filter((item) => item.enabled && item.url.trim()).map((item) => item.url);
  const latestLogs = enabledUrls.length === 0 ? [] : await db.pushLog.findMany({
    where: { webhookUrl: { in: enabledUrls }, event: { status: 'active' } },
    orderBy: { createdAt: 'desc' },
    select: { eventId: true, webhookUrl: true, status: true, event: { select: { representativeArticleId: true } } },
  });
  const seenTargets = new Set<string>();
  const pushFailedArticleIds = new Set<string>();
  for (const log of latestLogs) {
    const key = `${log.eventId}\u0000${log.webhookUrl}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    if (log.status === 'failure' && log.event.representativeArticleId) pushFailedArticleIds.add(log.event.representativeArticleId);
  }
  const technicalIds = new Set(technicalArticles.map((article) => article.id));
  for (const id of pushFailedArticleIds) technicalIds.add(id);
  const humanIds = new Set(humanArticles.map((article) => article.id));
  return {
    technical: {
      total: technicalIds.size,
      sources: failedSources,
      processFailed,
      clusterFailed,
      aiFailed,
      pushFailed: pushFailedArticleIds.size,
    },
    human: { total: humanIds.size, clusterReview, unreviewed, lowConfidence },
  };
}
