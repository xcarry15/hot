import { db } from '@/lib/db';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';

export async function getWorkQueueSummary() {
  const [technicalItems, failedSources, humanTotalRows, clusterReview, unreviewed, lowConfidence] = await Promise.all([
    getTechnicalWorkQueue(),
    db.source.count({ where: { deletedAt: null, OR: [{ status: 'warning' }, { status: 'breaker' }] } }),
    db.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(DISTINCT "id") AS "total"
      FROM "articles"
      WHERE "clusterStatus" = 'needs_review'
         OR "reviewStatus" = 'unreviewed'
         OR ("aiStatus" = 'done' AND "aiConfidence" < 70)
    `,
    db.article.count({ where: { clusterStatus: 'needs_review' } }),
    db.article.count({ where: { reviewStatus: 'unreviewed' } }),
    db.article.count({ where: { aiStatus: 'done', aiConfidence: { lt: 70 } } }),
  ]);
  const humanTotal = Number(humanTotalRows[0]?.total ?? 0);
  return {
    technical: {
      total: technicalItems.length,
      sources: failedSources,
      processFailed: technicalItems.filter((item) => item.issues.includes('process_failed')).length,
      clusterFailed: technicalItems.filter((item) => item.issues.includes('cluster_failed')).length,
      aiFailed: technicalItems.filter((item) => item.issues.includes('ai_failed')).length,
      pushFailed: technicalItems.filter((item) => item.issues.includes('push_failed')).length,
    },
    human: { total: humanTotal, clusterReview, unreviewed, lowConfidence },
  };
}
