import { Prisma } from '@prisma/client';
import { EVENT_CLUSTER_MAX_RETRIES } from '@/contracts/event-clustering';
import { db } from '@/lib/db';
import { clusterArticle, markClusterFailure } from '@/lib/event-clustering-service';
import { repairStaleEventRepresentatives } from '@/lib/event-service';
import { advanceJobProgress, startJobStage } from '@/lib/job-progress';
import { assertNotAborted } from '@/lib/worker-stop';

const MAX_CLUSTER_BATCH = 200;

export function buildClusterPendingWhere(now = new Date(), forceRetry = false): Prisma.ArticleWhereInput {
  return {
    fetchStatus: 'fetched',
    aiStatus: 'done',
    eventKey: { not: '' },
    technicalIgnoredAt: null,
    eventId: null,
    AND: [
      {
        OR: [
          { clusterStatus: 'pending' },
          { clusterStatus: 'failed', clusterRetryCount: { lt: EVENT_CLUSTER_MAX_RETRIES } },
        ],
      },
      ...(forceRetry ? [] : [{
        OR: [
          { nextClusterRetryAt: null },
          { nextClusterRetryAt: { lte: now } },
        ],
      }]),
    ],
  };
}

export async function clusterAllPending(signal?: AbortSignal, jobId?: string, forceRetry = false): Promise<{ total: number; processed: number; errors: number }> {
  const repairedRepresentatives = await repairStaleEventRepresentatives();
  if (repairedRepresentatives > 0) {
    console.warn(`[clusterAllPending] repaired ${repairedRepresentatives} stale Event representative pointer(s)`);
  }
  const total = await db.article.count({ where: buildClusterPendingWhere(new Date(), forceRetry) });
  if (jobId) await startJobStage(jobId, { stage: 'cluster', total });
  let processed = 0;
  let errors = 0;
  while (true) {
    const articles = await db.article.findMany({
      where: buildClusterPendingWhere(new Date(), forceRetry),
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_CLUSTER_BATCH,
    });
    if (articles.length === 0) break;
    for (const article of articles) {
      assertNotAborted(signal);
      let failed = false;
      try {
        await clusterArticle(article.id, signal);
        processed++;
      } catch (error) {
        if (signal?.aborted) throw error;
        failed = true;
        errors++;
        await markClusterFailure(article.id, error);
        console.error(`[clusterAllPending] failed article=${article.id}:`, error);
      }
      if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: failed ? 1 : 0, currentItemLabel: article.title });
    }
    if (articles.length < MAX_CLUSTER_BATCH) break;
  }
  return { total, processed, errors };
}
