import {
  LOW_ANALYSIS_CONFIDENCE_FILTER,
} from '@/contracts/ai-confidence';
import { CLUSTER_REVIEW_FILTER, HUMAN_ATTENTION_FILTER } from '@/lib/article-attention';
import { db } from '@/lib/db';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';

export async function getWorkQueueSummary() {
  const [technicalItems, failedSources, humanCounts] = await Promise.all([
    getTechnicalWorkQueue(),
    db.source.count({ where: { enabled: true, deletedAt: null, OR: [{ status: 'warning' }, { status: 'breaker' }] } }),
    db.$transaction([
      db.article.count({ where: HUMAN_ATTENTION_FILTER }),
      db.article.count({ where: CLUSTER_REVIEW_FILTER }),
      db.article.count({ where: LOW_ANALYSIS_CONFIDENCE_FILTER }),
    ]),
  ]);
  const [humanTotal, clusterReview, lowConfidence] = humanCounts;
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
