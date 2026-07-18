/**
 * Unified job execution entry point.
 *
 * Replaces the polling worker + queue-claim model. Since this is a single
 * Next.js process with one in-memory worker, scheduler and API routes now
 * call runJob() directly instead of enqueueing into a DB queue and waiting
 * for a polling loop to pick it up.
 *
 * Responsibilities:
 *   - In-memory concurrency guard (one global job at a time) — replaces the
 *     DB-based hasActiveJob() check.
 *   - Still writes a Job record (running → completed/failed) so the history
 *     view (/api/jobs) and the 3s frontend sync polling keep working.
 *   - Registers the AbortController via worker-stop so /api/worker/stop can
 *     cancel a running job started from any entry point (scheduler or API).
 *   - Wraps execution in runWithJobId so progress writes keep their Job context.
 *
 * runJob() awaits only the Job-record creation (fast) so the API can return
 * the jobId synchronously; the pipeline itself runs detached.
 */

import { collectAllSources, crawlSource } from './pipeline/collect';
import type { CrawlResult } from '@/contracts/crawl';
import { processAllPending } from './pipeline/process';
import { clusterAllPending } from './pipeline/cluster';
import { analyzeAllPending } from './pipeline/analyze';
import { reprocessWithAI } from './ai';
import { pushAllPendingArticles } from './pipeline/push-bridge';
import { shouldPushAtPipelineEnd } from './push/policy';
import { db } from './db';
import {
  getActiveJobType as getReservedJobType,
  tryReserveMutation,
  type MutationReservation,
} from './mutation-guard';
import { runWithJobId } from './job-context';
import {
  createJobAbortController,
  clearJobAbortController,
  abortCurrentJob,
  assertNotAborted,
} from './worker-stop';
import {
  markJobCompleted,
  markJobFailed,
  startJobHeartbeat,
  stopJobHeartbeat,
  startJobStage,
  advanceJobProgress,
} from './job-progress';

export type JobType = 'full' | 'collect' | 'process' | 'cluster' | 'ai' | 'push';
type JobExecutor = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
) => Promise<Record<string, unknown>>;

/** API 层使用的并发事实源：单进程内只允许一个批量 Job。 */
export function getActiveJobType(): JobType | null {
  return getReservedJobType<JobType>();
}

export interface RunJobDeclined {
  queued: false;
  reason: string;
}

export interface RunJobAccepted {
  queued: true;
  jobId: string;
}

/**
 * Start a job. Awaits only the Job-record creation (so the caller — API or
 * scheduler — gets the jobId immediately), then runs the pipeline detached.
 *
 * Concurrency: if any background job is already running, returns
 * { queued: false, reason } without starting anything.
 */
export async function runJob(
  type: JobType,
  payload: Record<string, unknown> = {}
): Promise<RunJobDeclined | RunJobAccepted> {
  const reservation = tryReserveMutation(`${type} 任务`, type);
  if (!reservation) {
    const activeJobType = getActiveJobType();
    return { queued: false, reason: activeJobType ? `${activeJobType} job already active` : 'another mutation already active' };
  }

  let job: { id: string };
  try {
    // Create the running record up front (fast, one insert). This gives the API
    // a jobId to return and lets the 3s frontend sync polling see the job.
    job = await db.job.create({
      data: {
        type,
        payload: JSON.stringify(payload),
        status: 'running',
        startedAt: new Date(),
      },
    });
  } catch (error) {
    // Reservation must never survive a failed Job insert.
    reservation.release();
    throw error;
  }

  // Detach the pipeline — caller does not wait for it.
  void runPipeline(type, payload, job.id, reservation);

  return { queued: true, jobId: job.id };
}

/** Detached pipeline execution. Owns AbortController + Job status finalization. */
async function runPipeline(
  type: JobType,
  payload: Record<string, unknown>,
  jobId: string,
  reservation: MutationReservation,
): Promise<void> {
  let controller: AbortController | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  console.log(`[execution] starting job ${jobId} (${type})`);

  try {
    const activeController = createJobAbortController(jobId);
    controller = activeController;
    // 30 秒心跳——执行链路可能持续几分钟，无心跳会让快照看起来"过期"。
    heartbeat = startJobHeartbeat(jobId, 30_000);
    const result = await runWithJobId(jobId, () =>
      executeJob(type, payload, activeController.signal, jobId)
    );
    await markJobCompleted(jobId, result);
    console.log(`[execution] completed job ${jobId} (${type})`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stopped = controller?.signal.aborted || msg === 'Stopped by user';
    console.error(`[execution] ${stopped ? 'stopped' : 'failed'} job ${jobId} (${type}):`, msg);
    await markJobFailed(jobId, stopped ? 'Stopped by user' : msg.slice(0, 2000));
  } finally {
    stopJobHeartbeat(heartbeat);
    reservation.release();
    clearJobAbortController(jobId);
  }
}

/**
 * Execute a single job by type. Extracted so it can be called directly by
 * runPipeline without the queue layer.
 */
async function executeJob(
  type: JobType,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const executor = JOB_EXECUTORS[type];
  if (!executor) throw new Error(`Unknown job type: ${type}`);
  return executor(payload, signal, jobId);
}

const JOB_EXECUTORS: Record<JobType, JobExecutor> = {
  full: executeFullJob,
  collect: executeCollectJob,
  process: executeProcessJob,
  cluster: executeClusterJob,
  ai: executeAiJob,
  push: executePushJob,
};

async function executeFullJob(
  _payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  assertNotAborted(signal);
  // 调度策略（重构 #3）：
  //  - Scheduler 触发：在 maybeEnqueueCrawl 中检查 lastCrawlAt + crawl_interval_min，
  //    到期才调用 runJob('full', { trigger: 'auto' })。
  //  - 手动触发（API / 前端按钮）：直接调用 runJob('full', { trigger: 'manual' })，
  //    跳过 scheduler 间隔；trigger 只记录来源，不改变流水线语义。
  //  - collectAllSources 不再接收 force 参数，差异由调用方（scheduler vs API）
  //    在所有到达本函数的路径上完成。
  //
  // 重构 #4：每个阶段调用都把 jobId 传进去，让 job-progress 模块持久化阶段进度。
  const collectResult = await collectAllSources(signal, jobId);

  assertNotAborted(signal);
  const processResult = await processAllPending(signal, jobId);
  let mergedProcess = processResult;
  if (processResult.capped) {
    assertNotAborted(signal);
    const processResult2 = await processAllPending(signal, jobId);
    mergedProcess = {
      total: processResult.total + processResult2.total,
      processed: processResult.processed + processResult2.processed,
      errors: processResult.errors + processResult2.errors,
      capped: processResult2.capped,
    };
  }

  assertNotAborted(signal);
  const clusterResult = await clusterAllPending(signal, jobId);
  assertNotAborted(signal);
  const aiResult = await analyzeAllPending(signal, jobId);
  assertNotAborted(signal);

  const result: Record<string, unknown> = {
    stages: {
      collect: summarizeCollectResult(collectResult),
      process: mergedProcess,
      cluster: clusterResult,
      ai: aiResult,
    },
  };
  if (await shouldPushAtPipelineEnd()) {
    const pushResult = await pushAllPendingArticles(signal, jobId);
    result.pushResult = pushResult;
    (result.stages as Record<string, unknown>).push = pushResult;
  } else {
    result.pushSkipped = true;
    result.reason = 'push_mode is not realtime';
  }

  return result;
}

async function executeCollectJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const sourceId = payload.sourceId as string | undefined;
  const sourceIds = Array.isArray(payload.sourceIds)
    ? [...new Set(payload.sourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 50)
    : [];
  if (sourceIds.length > 0) {
    const results: Array<CrawlResult & { sourceId: string; sourceName: string }> = [];
    if (jobId) await startJobStage(jobId, { stage: 'collect', total: sourceIds.length });
    for (const id of sourceIds) {
      assertNotAborted(signal);
      if (payload.resetSourceHealth === true) {
        await db.source.updateMany({
          where: { id },
          data: { consecutiveFailures: 0, status: 'normal', circuitBreakerUntil: null },
        });
      }
      const result = await collectSingleSource(id, signal);
      results.push(...result.results);
      if (jobId) {
        const sourceResult = result.results[0];
        await advanceJobProgress(jobId, {
          doneDelta: sourceResult?.success ? 1 : 0,
          errorDelta: sourceResult?.success ? 0 : 1,
          currentItemLabel: sourceResult?.sourceName ?? id,
        });
      }
    }
    return summarizeCollectResult({
      results,
      totalNewArticles: results.reduce((sum, item) => sum + item.items.length, 0),
      errors: results.filter(item => !item.success).length,
    });
  }
  if (sourceId) {
    if (payload.resetSourceHealth === true) {
      await db.source.update({
        where: { id: sourceId },
        data: {
          consecutiveFailures: 0,
          status: 'normal',
          circuitBreakerUntil: null,
        },
      });
    }
    const collectResult = await collectSingleSource(sourceId, signal, jobId);
    const sourceResult = collectResult.results[0];
    return {
      sourceId,
      result: {
        success: sourceResult?.success ?? false,
        itemsFound: sourceResult?.items.length ?? 0,
        error: sourceResult?.error,
      },
    };
  }
  const result = await collectAllSources(signal, jobId);
  return { result: summarizeCollectResult(result) };
}

async function executeClusterJob(
  _payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  return { result: await clusterAllPending(signal, jobId) };
}

async function executeProcessJob(
  _payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const result = await processAllPending(signal, jobId);
  return { result };
}

async function executeAiJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const articleId = typeof payload.articleId === 'string' ? payload.articleId : undefined;
  const articleIds = Array.isArray(payload.articleIds)
    ? [...new Set(payload.articleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  if (articleIds.length > 100) throw new Error('单次最多重新分析 100 篇文章');
  if (articleIds.length > 0) {
    if (jobId) await startJobStage(jobId, { stage: 'ai', total: articleIds.length });
    let processed = 0;
    let errors = 0;
    for (const id of articleIds) {
      assertNotAborted(signal);
      try {
        const result = await reprocessWithAI(id, signal);
        const failed = !result || result.status === 'failed';
        if (failed) errors++;
        else processed++;
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: failed ? 1 : 0 });
      } catch {
        errors++;
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, errorDelta: 1 });
      }
    }
    return { articleIds, processed, errors };
  }
  if (articleId) {
    const result = await reprocessWithAI(articleId, signal, jobId);
    return { articleId, result: result ?? { status: 'not_found' } };
  }
  const result = await analyzeAllPending(signal, jobId);
  return { result };
}

async function executePushJob(
  _payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const result = await pushAllPendingArticles(signal, jobId);
  return { result };
}

/**
 * Collect a single source — used by the source retry flow.
 * Returns the same shape as collectAllSources so summarizeCollectResult can be reused.
 * Job progress is persisted through job-progress.
 */
async function collectSingleSource(
  sourceId: string,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Awaited<ReturnType<typeof collectAllSources>>> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  const sourceName = source?.name || sourceId;
  if (jobId) {
    await startJobStage(jobId, { stage: 'collect', total: 1, currentItemLabel: sourceName });
  }

  let result;
  try {
    result = await crawlSource(sourceId, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { success: false, items: [], error: msg };
  }

  const results = [{ sourceId, sourceName, ...result }];
  if (jobId) {
    await advanceJobProgress(jobId, {
      doneDelta: result.success ? 1 : 0,
      errorDelta: result.success ? 0 : 1,
    });
  }
  return {
    results,
    totalNewArticles: result.items.length,
    errors: result.success ? 0 : 1,
  };
}

/**
 * Summarize a collect result so it can be stored in the Job table without
 * bloating the JSON payload with every parsed item.
 */
function summarizeCollectResult(
  result: Awaited<ReturnType<typeof collectAllSources>>
): Record<string, unknown> {
  return {
    totalSources: result.results.length,
    totalNewArticles: result.totalNewArticles,
    errors: result.errors,
    sources: result.results.map(r => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      success: r.success,
      itemsFound: r.items.length,
      error: r.error,
    })),
  };
}

/**
 * Abort the currently running job (called by /api/worker/stop).
 * Also marks any DB running jobs as failed to clean up orphan records.
 */
export async function abortRunningJob(): Promise<{ resetCount: number }> {
  const jobId = abortCurrentJob();
  if (jobId) {
    // The detached pipeline owns final status. Marking it failed here races
    // with cooperative cancellation and can be overwritten by a late success.
    return { resetCount: 0 };
  }

  // No in-process owner means any running rows are orphaned historical state.
  const reset = await db.job.updateMany({
    where: { status: 'running' },
    data: { status: 'failed', error: 'Stopped orphaned job', completedAt: new Date() },
  });
  return { resetCount: reset.count };
}

/**
 * Reset orphaned 'running' jobs left from a previous process crash / HMR.
 * Called once at scheduler startup.
 */
export async function resetOrphanedJobs(): Promise<void> {
  try {
    const result = await db.job.updateMany({
      where: { status: 'running' },
      data: { status: 'failed', error: 'Worker restarted while job was running', completedAt: new Date() },
    });
    if (result.count > 0) {
      console.log(`[execution] reset ${result.count} orphaned running job(s)`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[execution] failed to reset orphaned running jobs:', msg);
  }
}
