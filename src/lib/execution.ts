/**
 * Unified job execution entry point with DB-backed Job Lease (P0-1).
 *
 * All job state is persisted in the Job table — no in-memory-only state
 * determines correctness. runJob() creates a queued record and attempts to
 * atomically claim and execute it. The in-memory concurrency guard still
 * exists as a single-process optimization but correctness doesn't depend on it.
 */

import { collectAllSources, crawlSource } from './pipeline/collect';
import type { CrawlResult } from '@/contracts/crawl';
import { processAllPending } from './pipeline/process';
import { clusterAllPending } from './pipeline/cluster';
import { analyzeAllPending } from './pipeline/analyze';
import { reprocessWithAI } from './ai';
import { refetchArticle } from './article-refetch-service';
import { clusterArticle, markClusterFailure } from './event-clustering-service';
import { recalculateEventById } from './event-service';
import { getFailedPushTargets, pushArticleToFeishu } from './push/delivery';
import { pushAllPendingArticles } from './pipeline/push-bridge';
import { runStages, type PipelineStageTask } from './pipeline/stage-runner';
import { shouldPushAtPipelineEnd } from './push/policy';
import { db } from './db';
import { invalidateTechnicalWorkQueueCache } from './technical-work-queue-service';
import { invalidateDashboardAnalyticsCache } from './dashboard-analytics-service';
import { rebuildPendingSettings } from './settings-rebuild-service';
import {
  getActiveJobType as getReservedJobType,
  tryReserveMutation,
  type MutationReservation,
} from './mutation-guard';
import {
  acquireJobRunnerLease,
  clearExpiredJobRunnerLease,
  type JobRunnerLease,
} from './job-runner-lease';
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
  markJobCancelled,
  startJobHeartbeat,
  stopJobHeartbeat,
  startJobStage,
  advanceJobProgress,
} from './job-progress';
import { ACTIVE_JOB_STATUSES, CLAIMABLE_JOB_STATUSES } from './job-status';

export type JobType = 'full' | 'collect' | 'process' | 'ai' | 'cluster' | 'push';
type JobExecutor = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
) => Promise<Record<string, unknown>>;

const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const CANCELLATION_POLL_INTERVAL_MS = 1_000; // 1 second
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_BASE_DELAY_MS = 60_000;
const JOB_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

/** API 層使用的並發事實源：單進程內只允许一个批量 Job。 */
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

function computeIdempotencyKey(type: JobType, payload: Record<string, unknown>): string {
  if (payload.idempotencyKey && typeof payload.idempotencyKey === 'string') {
    return payload.idempotencyKey;
  }
  const trigger = typeof payload.trigger === 'string' ? payload.trigger : 'manual';
  if (trigger === 'auto_retry') {
    const minute = new Date().toISOString().slice(0, 16);
    return `technical-retry:${minute}`;
  }
  if (trigger === 'auto') {
    const now = new Date();
    if (type === 'push') return `daily-push:${now.toISOString().slice(0, 10)}`;
    const hour = now.toISOString().slice(0, 13) + ':00';
    return `crawl:${hour}`;
  }
  const articleId = typeof payload.articleId === 'string' ? payload.articleId : '';
  if (articleId && typeof payload.intent === 'string' && typeof payload.startAt === 'string') {
    return `workflow:${articleId}:${payload.intent}:${payload.startAt}`;
  }
  return `${type}:${trigger}:${Date.now()}`;
}

function workerId(): string {
  const pid = typeof process !== 'undefined' && process.pid ? String(process.pid) : '0';
  const host = typeof process !== 'undefined' && process.env?.HOSTNAME
    ? process.env.HOSTNAME : 'local';
  return `${host}:${pid}`;
}

async function checkJobCancellation(jobId: string): Promise<boolean> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return job?.status === 'cancel_requested';
}

async function assertJobNotCancelled(jobId: string): Promise<void> {
  if (await checkJobCancellation(jobId)) {
    throw new Error('Job cancelled');
  }
}

/** Attempt to atomically claim and start a queued job. Returns the jobId if claimed. */
async function claimAndRunJob(jobId: string): Promise<boolean> {
  const owner = workerId();
  const now = new Date();
  const leaseExpires = new Date(now.getTime() + LEASE_DURATION_MS);

  try {
    const updated = await db.job.updateMany({
      where: {
      id: jobId,
      status: { in: [...CLAIMABLE_JOB_STATUSES] },
      AND: [
        {
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        {
          OR: [
            { availableAt: null },
            { availableAt: { lte: now } },
          ],
        },
      ],
      },
      data: {
        status: 'running',
        leaseOwner: owner,
        leaseExpiresAt: leaseExpires,
        startedAt: now,
        availableAt: null,
        completedAt: null,
        error: '',
        attempt: { increment: 1 },
      },
    });
    return updated.count > 0;
  } catch (error) {
    console.error('[execution] claimAndRunJob failed:', error);
    return false;
  }
}

async function renewLease(jobId: string): Promise<void> {
  const now = new Date();
  await db.job.updateMany({
    where: { id: jobId, status: 'running', leaseOwner: workerId() },
    data: { leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS), heartbeatAt: now },
  });
}

/**
 * Stop routes can be compiled into a different module instance from the
 * detached executor. Poll the persisted state so a DB-only cancellation also
 * reaches the executor's AbortSignal while a stage is still running.
 */
function startJobCancellationWatcher(jobId: string, controller: AbortController): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const job = await db.job.findUnique({
          where: { id: jobId },
          select: { status: true },
        });
        if ((job?.status === 'cancel_requested' || job?.status === 'cancelled') && !controller.signal.aborted) {
          controller.abort();
        }
      } catch (error) {
        console.error(`[execution] cancellation check failed for ${jobId}:`, error);
      }
    })();
  }, CANCELLATION_POLL_INTERVAL_MS);
}

/**
 * Start a job. Creates a queued record with idempotency key, then atomically
 * claims and executes it. Concurrency is guarded by the in-memory guard
 * (single-process optimization) AND the DB lease (correctness guarantee).
 */
export async function runJob(
  type: JobType,
  payload: Record<string, unknown> = {}
): Promise<RunJobDeclined | RunJobAccepted> {
  const idempotencyKey = computeIdempotencyKey(type, payload);

  const reservation = tryReserveMutation(`${type} 任务`, type);
  if (!reservation) {
    const activeJobType = getActiveJobType();
    return { queued: false, reason: activeJobType ? `${activeJobType} job already active` : 'another mutation already active' };
  }

  try {
    const existing = await db.job.findFirst({
      where: {
        idempotencyKey,
        status: { in: ['queued', 'running'] },
        completedAt: null,
      },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status === 'running') {
        reservation.release();
        return { queued: false, reason: `${type} job with same key already running` };
      }
      const started = await startClaimedJob(type, payload, existing.id, reservation);
      if (started) return started;
      reservation.release();
      return { queued: false, reason: 'another job is active on this server or the queued job is not ready' };
    }

    // 先获得全局执行权再创建 Job，避免被拒绝的点击遗留一条稍后会自行执行的队列记录。
    const runnerLease = await acquireJobRunnerLease();
    if (!runnerLease) {
      reservation.release();
      return { queued: false, reason: 'another job is active on this server' };
    }
    try {
      const job = await db.job.create({
        data: {
          type,
          payload: JSON.stringify(payload),
          status: 'queued',
          idempotencyKey,
          attempt: 0,
          maxAttempts: JOB_MAX_ATTEMPTS,
        },
      });
      const started = await startClaimedJob(type, payload, job.id, reservation, runnerLease);
      if (started) return started;
      // 新建 Job 尚未被任何 worker 领取时，拒绝当前请求就必须同时移除记录；
      // 不能让“启动失败”的点击在调度器下次 tick 时变成幽灵任务。
      await db.job.deleteMany({
        where: { id: job.id, status: 'queued', attempt: 0 },
      });
      reservation.release();
      return { queued: false, reason: 'failed to claim queued job' };
    } catch (error) {
      await runnerLease.release();
      throw error;
    }
  } catch (error) {
    reservation.release();
    throw error;
  }
}

/**
 * 领取一条到期的持久化队列 Job。调度器与启动恢复共用此入口，
 * 因此进程重启、租约过期和短暂数据库异常都不会让 Job 永久停在队列中。
 */
export async function resumeQueuedJob(): Promise<RunJobAccepted | null> {
  const reservation = tryReserveMutation('恢复任务');
  if (!reservation) return null;

  let started = false;
  try {
    const now = new Date();
    const queued = await db.job.findFirst({
      where: {
        status: 'queued',
        OR: [
          { availableAt: null },
          { availableAt: { lte: now } },
        ],
      },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, type: true, payload: true },
    });
    if (!queued) return null;

    const payload = parseJobPayload(queued.payload);
    if (!isRunnableJobType(queued.type) || !payload) {
      await db.job.updateMany({
        where: { id: queued.id, status: 'queued' },
        data: {
          status: 'failed',
          error: '任务定义无效，无法恢复',
          completedAt: now,
          heartbeatAt: now,
        },
      });
      return null;
    }

    const result = await startClaimedJob(queued.type, payload, queued.id, reservation);
    if (!result) return null;
    started = true;
    return result;
  } catch (error) {
    console.error('[execution] failed to resume queued job:', error);
    return null;
  } finally {
    if (!started) reservation.release();
  }
}

/** Detached pipeline execution with DB lease + cancellation support. */
async function runPipeline(
  type: JobType,
  payload: Record<string, unknown>,
  jobId: string,
  reservation: MutationReservation,
  runnerLease: JobRunnerLease,
): Promise<void> {
  let controller: AbortController | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  let cancellationTimer: NodeJS.Timeout | null = null;
  console.log(`[execution] starting job ${jobId} (${type})`);

  try {
    const activeController = createJobAbortController(jobId);
    controller = activeController;
    cancellationTimer = startJobCancellationWatcher(jobId, activeController);
    heartbeat = startJobHeartbeat(jobId, HEARTBEAT_INTERVAL_MS);

    // Periodic lease renewal — if the process hangs, the lease expires and
    // another worker can claim the job.
    leaseTimer = setInterval(() => {
      void Promise.all([renewLease(jobId), runnerLease.renew()]).then(([, runnerLeaseRenewed]) => {
        if (!runnerLeaseRenewed && !activeController.signal.aborted) {
          console.error(`[execution] global runner lease lost for ${jobId}; stopping stale worker`);
          activeController.abort(new Error('Global job runner lease lost'));
        }
      }).catch((err) => {
        console.error(`[execution] lease renewal failed for ${jobId}:`, err);
      });
    }, 60_000);

    const result = await runWithJobId(jobId, () =>
      executeJob(type, payload, activeController.signal, jobId)
    );
    await assertJobNotCancelled(jobId);
    await markJobCompleted(jobId, result);
    console.log(`[execution] completed job ${jobId} (${type})`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const cancelled = msg === 'Job cancelled' || controller?.signal.aborted || msg === 'Stopped by user';
    console.error(`[execution] ${cancelled ? 'cancelled' : 'failed'} job ${jobId} (${type}):`, msg);

    if (cancelled) await markJobCancelled(jobId, 'Stopped by user');
    else {
      try {
        const retry = await requeueJobAfterFailure(jobId, msg);
        if (retry.requeued) {
          console.warn(`[execution] job ${jobId} will retry at ${retry.retryAt?.toISOString()}`);
        } else {
          await markJobFailed(jobId, msg.slice(0, 2000));
        }
      } catch (retryError) {
        console.error(`[execution] failed to requeue ${jobId}:`, retryError);
        await markJobFailed(jobId, msg.slice(0, 2000));
      }
    }
  } finally {
    invalidateTechnicalWorkQueueCache();
    invalidateDashboardAnalyticsCache();
    stopJobHeartbeat(heartbeat);
    if (leaseTimer) clearInterval(leaseTimer);
    if (cancellationTimer) clearInterval(cancellationTimer);
    try {
      await runnerLease.release();
    } catch (error) {
      console.error(`[execution] failed to release global runner lease for ${jobId}:`, error);
    }
    reservation.release();
    clearJobAbortController(jobId);
  }
}

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
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (payload.settingsRebuild === true) {
    assertNotAborted(signal);
    return { settingsRebuild: await rebuildPendingSettings() };
  }
  const skipCollect = payload.skipCollect === true;
  const forceRetry = payload.forceRetry === true;
  const pushEnabled = await shouldPushAtPipelineEnd();
  const tasks: PipelineStageTask[] = [
    {
      key: 'collect',
      run: async () => skipCollect
        ? { skipped: true, reason: 'technical-retry' }
        : summarizeCollectResult(await collectAllSources(signal, jobId)),
    },
    {
      key: 'process',
      run: () => processAllPending(signal, jobId, forceRetry),
      onError: async () => {
        // 详情抓取在中途遇到进程级异常时，已成功抓完的文章仍可继续走 AI/聚类。
        // 任务本身会进入有限重试，但不让本轮已完成工作白白滞留。
        if (signal?.aborted) return;
        try {
          await analyzeAllPending(signal, jobId, forceRetry);
        } finally {
          if (!signal?.aborted) await clusterAllPending(signal, jobId, forceRetry);
        }
      },
    },
    {
      key: 'ai',
      run: () => analyzeAllPending(signal, jobId, forceRetry),
      onError: async () => {
        // AI 阶段的异常不应阻止已经完成 AI 的文章进入聚类；这是唯一明确
        // 声明的阶段补偿策略，不能再散落在多个执行分支的 try/catch 中。
        if (!signal?.aborted) await clusterAllPending(signal, jobId, forceRetry);
      },
    },
    {
      key: 'cluster',
      run: () => clusterAllPending(signal, jobId, forceRetry),
    },
  ];
  if (pushEnabled) tasks.push({ key: 'push', run: () => pushAllPendingArticles(signal, jobId) });

  const stages = await runStages(tasks, {
    signal,
    beforeStage: async () => {
      if (jobId) await assertJobNotCancelled(jobId);
    },
  });
  const result: Record<string, unknown> = { stages };
  if (!pushEnabled) {
    result.pushSkipped = true;
    result.reason = 'push_mode is not realtime';
  } else {
    result.pushResult = stages.push;
  }
  return result;
}

function isRunnableJobType(type: string): type is JobType {
  return ['full', 'collect', 'process', 'ai', 'cluster', 'push'].includes(type);
}

function parseJobPayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    JOB_RETRY_MAX_DELAY_MS,
    JOB_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
  );
}

async function startClaimedJob(
  type: JobType,
  payload: Record<string, unknown>,
  jobId: string,
  reservation: MutationReservation,
  existingRunnerLease?: JobRunnerLease,
): Promise<RunJobAccepted | null> {
  const runnerLease = existingRunnerLease ?? await acquireJobRunnerLease();
  if (!runnerLease) return null;

  const claimed = await claimAndRunJob(jobId);
  if (!claimed) {
    await runnerLease.release();
    return null;
  }

  void runPipeline(type, payload, jobId, reservation, runnerLease);
  return { queued: true, jobId };
}

/**
 * 将非人工取消的任务异常转为有限次数的延迟重试。
 *
 * Job 仅负责进程级异常的续跑；文章级失败仍由各阶段自己的退避字段处理，
 * 因此不会把已达到文章重试上限的记录重新激活。
 */
async function requeueJobAfterFailure(
  jobId: string,
  errorMessage: string,
): Promise<{ requeued: boolean; retryAt?: Date }> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { status: true, attempt: true, maxAttempts: true },
  });
  if (!job || job.status !== 'running' || job.attempt >= job.maxAttempts) {
    return { requeued: false };
  }

  const now = new Date();
  const retryAt = new Date(now.getTime() + retryDelayMs(job.attempt));
  const updated = await db.job.updateMany({
    where: { id: jobId, status: 'running', attempt: job.attempt },
    data: {
      status: 'queued',
      error: errorMessage.slice(0, 2000),
      currentStage: null,
      currentItemLabel: `任务异常，将于 ${retryAt.toLocaleTimeString('zh-CN', { hour12: false })} 自动重试`,
      heartbeatAt: now,
      leaseOwner: '',
      leaseExpiresAt: null,
      availableAt: retryAt,
      startedAt: null,
      completedAt: null,
    },
  });
  return updated.count === 1 ? { requeued: true, retryAt } : { requeued: false };
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
      if (jobId) await assertJobNotCancelled(jobId);
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
          doneDelta: 1,
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
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  return { result: await clusterAllPending(signal, jobId) };
}

async function executeProcessJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  const result = await processAllPending(signal, jobId);
  return { result };
}

async function executeAiJob(
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
    let cluster: Awaited<ReturnType<typeof clusterArticle>> | null = null;
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

async function executePushJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (isSingleWorkflow(payload)) return executeSingleArticleWorkflow(payload, signal, jobId);
  const result = await pushAllPendingArticles(signal, jobId);
  return { result };
}

type SingleWorkflowStart = 'process' | 'cluster' | 'ai' | 'push';
type SingleWorkflowIntent = 'retry' | 'regenerate';

export async function validateSingleArticleWorkflow(
  articleId: string,
  startAt: SingleWorkflowStart,
  intent: SingleWorkflowIntent,
): Promise<{ ok: true } | { ok: false; status: 404 | 409; reason: string }> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: { fetchStatus: true, clusterStatus: true, aiStatus: true, skipReason: true, eventId: true, event: { select: { nextPushRetryAt: true, pushRetryCount: true } } },
  });
  if (!article) return { ok: false, status: 404, reason: '文章不存在' };
  if (intent === 'regenerate') {
    if (startAt === 'push') return { ok: false, status: 409, reason: '完整重新推送请使用 Event 人工推送' };
    return { ok: true };
  }
  if (startAt === 'process' && article.fetchStatus !== 'failed') {
    return { ok: false, status: 409, reason: '正文处理未失败，不能执行技术重试' };
  }
  if (startAt === 'cluster' && article.clusterStatus !== 'failed') {
    return { ok: false, status: 409, reason: '聚类未失败，不能执行技术重试' };
  }
  if (startAt === 'ai' && article.aiStatus !== 'failed' && !(article.aiStatus === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))) {
    return { ok: false, status: 409, reason: 'AI 当前不是可恢复失败，不能执行技术重试' };
  }
  if (startAt === 'push') {
    if (!article.eventId) return { ok: false, status: 409, reason: '文章尚未归属 Event，不能重试推送' };
    if ((await getFailedPushTargets(article.eventId)).length === 0) {
      return { ok: false, status: 409, reason: '当前没有失败的推送目标' };
    }
    if (article.event?.nextPushRetryAt && article.event.nextPushRetryAt > new Date()) {
      return { ok: false, status: 409, reason: `推送重试等待中，可重试时间: ${article.event.nextPushRetryAt.toISOString()}` };
    }
  }
  return { ok: true };
}

function isSingleWorkflow(payload: Record<string, unknown>): boolean {
  return payload.scope === 'single' && payload.workflow === true && typeof payload.articleId === 'string';
}

async function executeSingleArticleWorkflow(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const articleId = payload.articleId as string;
  const startAt = payload.startAt as SingleWorkflowStart;
  const intent = payload.intent as SingleWorkflowIntent;
  const valid: readonly SingleWorkflowStart[] = ['process', 'cluster', 'ai', 'push'];
  if (!valid.includes(startAt)) throw new Error('Invalid single article workflow start stage');
  const article = await db.article.findUnique({ where: { id: articleId }, select: { id: true, title: true, eventId: true } });
  if (!article) throw new Error('Article not found');
  if (intent !== 'retry' && intent !== 'regenerate') throw new Error('Invalid single article workflow intent');
  await db.article.update({ where: { id: articleId }, data: { technicalIgnoredAt: null } });
  let aiResult: Awaited<ReturnType<typeof reprocessWithAI>> | undefined;
  const stageResults = await runStages([
    {
      key: 'process',
      shouldRun: () => startAt === 'process',
      run: async () => {
        if (jobId) await startJobStage(jobId, { stage: 'process', total: 1, currentItemLabel: article.title });
        const processResult = await refetchArticle(articleId);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        if (!processResult || processResult.success !== true) {
          const reason = processResult?.error || '未获取到有效正文';
          throw new Error(`正文重新获取失败：${reason}；已停止后续 AI 分析和事件聚类`);
        }
        return processResult;
      },
    },
    {
      key: 'ai',
      shouldRun: () => startAt === 'process' || startAt === 'ai',
      run: async () => {
        if (startAt === 'ai') await prepareArticleForAiRegeneration(articleId);
        aiResult = await reprocessWithAI(articleId, signal, jobId);
        return aiResult;
      },
    },
    {
      key: 'cluster',
      shouldRun: () => startAt === 'cluster' || aiResult?.status === 'done',
      run: async () => {
        await db.article.update({
          where: { id: articleId },
          data: {
            ...(intent === 'regenerate' ? { eventId: null } : {}),
            clusterStatus: 'pending',
            clusteredAt: null,
            clusterError: null,
            clusterRetryCount: 0,
            nextClusterRetryAt: null,
          },
        });
        if (intent === 'regenerate' && article.eventId) await recalculateEventById(article.eventId);
        if (jobId) await startJobStage(jobId, { stage: 'cluster', total: 1, currentItemLabel: article.title });
        const clusterResult = await clusterSingleArticle(articleId, signal);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        return clusterResult;
      },
    },
    {
      key: 'push',
      shouldRun: () => startAt === 'push',
      run: async () => {
        if (jobId) await startJobStage(jobId, { stage: 'push', total: 1, currentItemLabel: article.title });
        if (article.eventId) {
          await db.event.update({ where: { id: article.eventId }, data: { pushRetryCount: 0, nextPushRetryAt: null } });
        }
        const pushResult = await pushArticleToFeishu(articleId, 'retry_failed', signal);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        return pushResult;
      },
    },
  ], {
    signal,
    beforeStage: async () => {
      if (jobId) await assertJobNotCancelled(jobId);
    },
  });
  return { articleId, startAt, intent, stages: Object.keys(stageResults), ...stageResults };
}

async function prepareArticleForAiRegeneration(articleId: string): Promise<void> {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { eventId: true } });
  if (!article) return;
  await db.article.update({
    where: { id: articleId },
    data: {
      eventId: null,
      clusterStatus: 'pending',
      clusteredAt: null,
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
    },
  });
  if (article.eventId) await recalculateEventById(article.eventId);
}

async function clusterSingleArticle(articleId: string, signal?: AbortSignal) {
  try {
    return await clusterArticle(articleId, signal);
  } catch (error) {
    await markClusterFailure(articleId, error);
    throw error;
  }
}

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
      doneDelta: 1,
      errorDelta: result.success ? 0 : 1,
    });
  }
  return {
    results,
    totalNewArticles: result.items.length,
    errors: result.success ? 0 : 1,
  };
}

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
 * Request cancellation for every running job. The database write must happen
 * even when the stop route and the executor do not share the same module
 * instance; the in-memory controller only provides faster cancellation in the
 * current process.
 */
export async function abortRunningJob(): Promise<{ resetCount: number }> {
  const jobId = abortCurrentJob();
  const requested = await db.job.updateMany({
    where: { status: 'running' },
    data: { status: 'cancel_requested', cancelRequestedAt: new Date() },
  });
  if (jobId || requested.count > 0) {
    return { resetCount: 0 };
  }

  // No active running job — reset only already-requested orphaned jobs.
  const now = new Date();
  const reset = await db.job.updateMany({
    where: {
      status: { in: [...ACTIVE_JOB_STATUSES] },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: 'cancelled',
      error: 'Stopped by admin (expired lease)',
      completedAt: now,
      heartbeatAt: now,
      leaseOwner: '',
      leaseExpiresAt: null,
    },
  });
  return { resetCount: reset.count };
}

/**
 * 恢复租约已过期的 Job。人工取消只收尾为 cancelled；其他运行中任务在
 * 剩余尝试次数内重新入队，避免一次进程重启直接丢掉整批待处理文章。
 */
export async function resetOrphanedJobs(): Promise<{ requeued: number; failed: number; cancelled: number }> {
  try {
    await clearExpiredJobRunnerLease();
    const now = new Date();
    const orphaned = await db.job.findMany({
      where: {
        status: { in: [...ACTIVE_JOB_STATUSES] },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      select: { id: true, status: true, attempt: true, maxAttempts: true },
      take: 20,
    });
    let requeued = 0;
    let failed = 0;
    let cancelled = 0;
    for (const job of orphaned) {
      const canRetry = job.status === 'running' && job.attempt < job.maxAttempts;
      const retryAt = canRetry
        ? new Date(now.getTime() + retryDelayMs(job.attempt))
        : null;
      const result = await db.job.updateMany({
        where: {
          id: job.id,
          status: job.status,
          attempt: job.attempt,
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: canRetry
          ? {
            status: 'queued',
            error: 'Worker restarted (expired lease)',
            currentStage: null,
            currentItemLabel: `Worker 已重启，将于 ${retryAt!.toLocaleTimeString('zh-CN', { hour12: false })} 自动恢复`,
            heartbeatAt: now,
            leaseOwner: '',
            leaseExpiresAt: null,
            availableAt: retryAt,
            startedAt: null,
            completedAt: null,
          }
          : {
            status: job.status === 'cancel_requested' ? 'cancelled' : 'failed',
            error: job.status === 'cancel_requested'
              ? 'Stopped by user'
              : 'Worker restarted after maximum retry attempts',
            completedAt: now,
            heartbeatAt: now,
            leaseOwner: '',
            leaseExpiresAt: null,
          },
      });
      if (result.count === 0) continue;
      if (canRetry) requeued++;
      else if (job.status === 'cancel_requested') cancelled++;
      else failed++;
    }
    if (requeued + failed + cancelled > 0) {
      console.log(`[execution] recovered orphaned jobs: requeued=${requeued}, failed=${failed}, cancelled=${cancelled}`);
    }
    return { requeued, failed, cancelled };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[execution] failed to reset orphaned jobs:', msg);
    return { requeued: 0, failed: 0, cancelled: 0 };
  }
}
