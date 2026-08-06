import { Prisma } from '@prisma/client';
import { EVENT_CLUSTER_MAX_RETRIES } from '@/contracts/event-clustering';
import { db } from '@/lib/db';
import { clusterArticle, markClusterFailure } from '@/lib/event-clustering-service';
import { autoConfirmSingleArticleReviewEvents, repairStaleEventRepresentatives } from '@/lib/event-service';
import { repairAttachedClusterFailures, repairDirtyEvents, repairDuplicateEventKeyCandidates, repairPersistedCandidateReviews } from '@/lib/event/event-consistency-service';
import { advanceJobProgress, startJobStage } from '@/lib/job-progress';
import { assertNotAborted } from '@/lib/worker-stop';

const MAX_CLUSTER_BATCH = 200;

export function buildClusterPendingWhere(now = new Date(), forceRetry = false): Prisma.ArticleWhereInput {
  return {
    fetchStatus: 'fetched',
    aiStatus: 'done',
    technicalIgnoredAt: null,
    eventId: null,
    AND: [
      {
        OR: [
          { clusterStatus: 'pending' },
          { clusterStatus: 'needs_review' },
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
  const repairedDuplicateEventKeys = await repairDuplicateEventKeyCandidates();
  if (repairedDuplicateEventKeys > 0) {
    console.warn(`[clusterAllPending] moved ${repairedDuplicateEventKeys} duplicate eventKey Event(s) to review`);
  }
  const repairedPersistedCandidates = await repairPersistedCandidateReviews();
  if (repairedPersistedCandidates > 0) {
    console.warn(`[clusterAllPending] moved ${repairedPersistedCandidates} persisted candidate Article(s) to review`);
  }
  const autoConfirmedReviewEvents = await autoConfirmSingleArticleReviewEvents();
  if (autoConfirmedReviewEvents > 0) {
    console.warn(`[clusterAllPending] auto-confirmed ${autoConfirmedReviewEvents} standalone review Event(s)`);
  }
  const repairedAttachedFailures = await repairAttachedClusterFailures();
  if (repairedAttachedFailures > 0) {
    console.warn(`[clusterAllPending] repaired ${repairedAttachedFailures} attached failed Article(s)`);
  }
  const repairedDirtyEvents = await repairDirtyEvents();
  if (repairedDirtyEvents > 0) {
    console.warn(`[clusterAllPending] repaired ${repairedDirtyEvents} dirty Event(s)`);
  }
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
      // 事件候选以发布时间窗召回。历史补采按入库时间会打乱事件先后，
      // 导致同一新闻无法稳定进入同一轮候选池。
      orderBy: [{ publishedAt: 'asc' }, { createdAt: 'asc' }],
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
  }
  return { total, processed, errors };
}
