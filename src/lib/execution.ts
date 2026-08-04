/**
 * Unified job execution entry point with DB-backed Job Lease (P0-1).
 *
 * All job state is persisted in the Job table — no in-memory-only state
 * determines correctness. runJob() creates a queued record and attempts to
 * atomically claim and execute it. The in-memory concurrency guard still
 * exists as a single-process optimization but correctness doesn't depend on it.
 */

import { collectAllSources } from './pipeline/collect';
import { processAllPending } from './pipeline/process';
import { analyzeAllPending } from './pipeline/analyze';
import { clusterAllPending } from './pipeline/cluster';
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
} from './job-progress';
import { ACTIVE_JOB_STATUSES, CLAIMABLE_JOB_STATUSES } from './job-status';
import { assertJobNotCancelled } from './execution-cancellation';
import { executeCollectJob, summarizeCollectResult } from './execution-collect';
import { executeAiJob } from './execution-ai';
import {
  executeClusterJob,
  executeProcessJob,
  executePushJob,
} from './execution-stage-executors';
import type { JobExecutor, JobType } from './execution-types';

export type { JobType } from './execution-types';
export {
  validateBatchArticleRegeneration,
  validateSingleArticleWorkflow,
} from './execution-article-workflow';

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

async function renewLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const updated = await db.job.updateMany({
    where: { id: jobId, status: 'running', leaseOwner: workerId() },
    data: { leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS), heartbeatAt: now },
  });
  return updated.count === 1;
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
          controller.abort(new Error('Job cancelled'));
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
  let heartbeat: NodeJS.Timeout | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  let cancellationTimer: NodeJS.Timeout | null = null;
  console.log(`[execution] starting job ${jobId} (${type})`);

  try {
    const activeController = createJobAbortController(jobId);
    cancellationTimer = startJobCancellationWatcher(jobId, activeController);
    heartbeat = startJobHeartbeat(jobId, HEARTBEAT_INTERVAL_MS);

    // Periodic lease renewal — if the process hangs, the lease expires and
    // another worker can claim the job.
    leaseTimer = setInterval(() => {
      void Promise.all([renewLease(jobId), runnerLease.renew()]).then(([jobLeaseRenewed, runnerLeaseRenewed]) => {
        if ((!jobLeaseRenewed || !runnerLeaseRenewed) && !activeController.signal.aborted) {
          console.error(`[execution] runner lease lost for ${jobId}; stopping stale worker`);
          activeController.abort(new Error('Job runner lease lost'));
        }
      }).catch((err) => {
        console.error(`[execution] lease renewal failed for ${jobId}:`, err);
        if (!activeController.signal.aborted) {
          activeController.abort(new Error('Job runner lease renewal failed'));
        }
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
    const cancelled = msg === 'Job cancelled' || msg === 'Stopped by user';
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
