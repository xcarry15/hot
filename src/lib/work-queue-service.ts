import { db } from '@/lib/db';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';

export async function getWorkQueueSummary() {
  const [technicalItems, failedSources, humanTotalRows, clusterReview, lowConfidence] = await Promise.all([
    getTechnicalWorkQueue(),
    db.source.count({ where: { enabled: true, deletedAt: null, OR: [{ status: 'warning' }, { status: 'breaker' }] } }),
    db.$queryRaw<Array<{ total: bigint | number }>>`
      SELECT COUNT(DISTINCT "id") AS "total"
      FROM "articles"
      WHERE "clusterStatus" = 'needs_review'
         OR ("aiStatus" = 'done' AND "aiConfidence" < 70)
    `,
    db.article.count({ where: { clusterStatus: 'needs_review' } }),
    db.article.count({ where: { aiStatus: 'done', aiConfidence: { lt: 70 } } }),
  ]);
  const humanTotal = Number(humanTotalRows[0]?.total ?? 0);
  const manualTechnicalItems = technicalItems.filter((item) => item.state === 'manual');
  return {
    technical: {
      total: manualTechnicalItems.length,
      sources: failedSources,
      processFailed: manualTechnicalItems.filter((item) => item.issues.includes('process_failed')).length,
      clusterFailed: manualTechnicalItems.filter((item) => item.issues.includes('cluster_failed')).length,
      aiFailed: manualTechnicalItems.filter((item) => item.issues.includes('ai_failed')).length,
      pushFailed: manualTechnicalItems.filter((item) => item.issues.includes('push_failed')).length,
      autoRetry: technicalItems.filter((item) => item.state === 'auto_retry').length,
    },
    human: { total: humanTotal, clusterReview, lowConfidence },
  };
}
