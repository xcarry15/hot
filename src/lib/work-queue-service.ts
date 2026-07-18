import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';

export async function getWorkQueueSummary() {
  const humanWhere: Prisma.ArticleWhereInput = { OR: [
    { clusterStatus: 'needs_review' },
    { reviewStatus: 'unreviewed' },
    { aiStatus: 'done', aiConfidence: { lt: 70 } },
  ] };
  const [technicalItems, failedSources, humanArticles, clusterReview, unreviewed, lowConfidence] = await Promise.all([
    getTechnicalWorkQueue(),
    db.source.count({ where: { deletedAt: null, OR: [{ status: 'warning' }, { status: 'breaker' }] } }),
    db.article.findMany({ where: humanWhere, select: { id: true } }),
    db.article.count({ where: { clusterStatus: 'needs_review' } }),
    db.article.count({ where: { reviewStatus: 'unreviewed' } }),
    db.article.count({ where: { aiStatus: 'done', aiConfidence: { lt: 70 } } }),
  ]);
  const humanIds = new Set(humanArticles.map((article) => article.id));
  return {
    technical: {
      total: technicalItems.length,
      sources: failedSources,
      processFailed: technicalItems.filter((item) => item.issues.includes('process_failed')).length,
      clusterFailed: technicalItems.filter((item) => item.issues.includes('cluster_failed')).length,
      aiFailed: technicalItems.filter((item) => item.issues.includes('ai_failed')).length,
      pushFailed: technicalItems.filter((item) => item.issues.includes('push_failed')).length,
    },
    human: { total: humanIds.size, clusterReview, unreviewed, lowConfidence },
  };
}
