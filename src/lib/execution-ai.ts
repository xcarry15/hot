import { reprocessWithAI } from './ai';
import { assertJobNotCancelled } from './execution-cancellation';
import {
  clusterSingleArticle,
  executeSingleArticleWorkflow,
  isSingleWorkflow,
  prepareArticleForAiRegeneration,
} from './execution-article-workflow';
import { advanceJobProgress, startJobStage } from './job-progress';
import { analyzeAllPending } from './pipeline/analyze';
import { runStages } from './pipeline/stage-runner';
import { assertNotAborted } from './worker-stop';

export async function executeAiJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  const articleId = typeof payload.articleId === 'string' ? payload.articleId : undefined;
  const articleIds = Array.isArray(payload.articleIds)
    ? [...new Set(payload.articleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  if (articleIds.length > 100) throw new Error('单次最多重新分析 100 篇文章');
  if (articleIds.length > 0) {
    let analyzedIds: string[] = [];
    const stages = await runStages([
      {
        key: 'ai',
        run: async () => {
          if (jobId) await startJobStage(jobId, { stage: 'ai', total: articleIds.length });
          let processed = 0;
          let errors = 0;
          analyzedIds = [];
          for (const id of articleIds) {
            assertNotAborted(signal);
            if (jobId) await assertJobNotCancelled(jobId);
            try {
              await prepareArticleForAiRegeneration(id);
              const result = await reprocessWithAI(id, signal);
              const failed = !result || result.status === 'failed';
              if (failed) errors++;
              else {
                processed++;
                if (result.status === 'done') analyzedIds.push(id);
              }
              if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: failed ? 1 : 0 });
            } catch {
              errors++;
              if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: 1 });
            }
          }
          return { processed, errors, analyzedIds };
        },
      },
      {
        key: 'cluster',
        shouldRun: () => analyzedIds.length > 0,
        run: async () => {
          if (jobId) await startJobStage(jobId, { stage: 'cluster', total: analyzedIds.length });
          let clustered = 0;
          let clusterErrors = 0;
          for (const id of analyzedIds) {
            assertNotAborted(signal);
            if (jobId) await assertJobNotCancelled(jobId);
            let failed = false;
            try {
              await clusterSingleArticle(id, signal);
              clustered++;
            } catch {
              failed = true;
              clusterErrors++;
            }
            if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: failed ? 1 : 0 });
          }
          return { clustered, clusterErrors };
        },
      },
    ], {
      signal,
      beforeStage: async () => {
        if (jobId) await assertJobNotCancelled(jobId);
      },
    });
    const ai = stages.ai as { processed: number; errors: number; analyzedIds: string[] };
    const cluster = stages.cluster as { clustered: number; clusterErrors: number } | undefined;
    return {
      articleIds,
      processed: ai.processed,
      errors: ai.errors,
      clustered: cluster?.clustered ?? 0,
      clusterErrors: cluster?.clusterErrors ?? 0,
    };
  }
  if (articleId) {
    await prepareArticleForAiRegeneration(articleId);
    const result = await reprocessWithAI(articleId, signal, jobId);
    let cluster: Awaited<ReturnType<typeof clusterSingleArticle>> | null = null;
    if (result?.status === 'done') {
      if (jobId) await startJobStage(jobId, { stage: 'cluster', total: 1 });
      cluster = await clusterSingleArticle(articleId, signal);
      if (jobId) await advanceJobProgress(jobId, { doneDelta: 1 });
    }
    return { articleId, result: result ?? { status: 'not_found' }, cluster };
  }
  const result = await analyzeAllPending(signal, jobId);
  return { result };
}
