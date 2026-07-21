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
import { shouldPushAtPipelineEnd } from './push/policy';
import { db } from './db';
import { invalidateTechnicalWorkQueueCache } from './technical-work-queue-service';
import { invalidateDashboardAnalyticsCache } from './dashboard-analytics-service';
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
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: 'running',
        leaseOwner: owner,
        leaseExpiresAt: leaseExpires,
        startedAt: now,
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

  let job: { id: string };
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
      const claimed = await claimAndRunJob(existing.id);
      if (claimed) {
        void runPipeline(type, payload, existing.id, reservation);
        return { queued: true, jobId: existing.id };
      }
      reservation.release();
      return { queued: false, reason: 'duplicate job already queued' };
    }

    job = await db.job.create({
      data: {
        type,
        payload: JSON.stringify(payload),
        status: 'queued',
        idempotencyKey,
        attempt: 0,
        maxAttempts: 1,
      },
    });
  } catch (error) {
    reservation.release();
    throw error;
  }

  const claimed = await claimAndRunJob(job.id);
  if (!claimed) {
    reservation.release();
    return { queued: false, reason: 'failed to claim queued job' };
  }

  void runPipeline(type, payload, job.id, reservation);
  return { queued: true, jobId: job.id };
}

/** Detached pipeline execution with DB lease + cancellation support. */
async function runPipeline(
  type: JobType,
  payload: Record<string, unknown>,
  jobId: string,
  reservation: MutationReservation,
): Promise<void> {
  let controller: AbortController | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  console.log(`[execution] starting job ${jobId} (${type})`);

  try {
    const activeController = createJobAbortController(jobId);
    controller = activeController;
    heartbeat = startJobHeartbeat(jobId, HEARTBEAT_INTERVAL_MS);

    // Periodic lease renewal — if the process hangs, the lease expires and
    // another worker can claim the job.
    leaseTimer = setInterval(() => {
      void renewLease(jobId).catch((err) => {
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
    else await markJobFailed(jobId, msg.slice(0, 2000));
  } finally {
    invalidateTechnicalWorkQueueCache();
    invalidateDashboardAnalyticsCache();
    stopJobHeartbeat(heartbeat);
    if (leaseTimer) clearInterval(leaseTimer);
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
  _payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  assertNotAborted(signal);
  if (jobId) await assertJobNotCancelled(jobId);

  const collectResult = await collectAllSources(signal, jobId);

  assertNotAborted(signal);
  if (jobId) await assertJobNotCancelled(jobId);
  const processResult = await processAllPending(signal, jobId);

  assertNotAborted(signal);
  if (jobId) await assertJobNotCancelled(jobId);
  let aiResult: Awaited<ReturnType<typeof analyzeAllPending>>;
  try {
    aiResult = await analyzeAllPending(signal, jobId);
  } catch (error) {
    if (!signal?.aborted) await clusterAllPending(signal, jobId);
    throw error;
  }
  assertNotAborted(signal);
  if (jobId) await assertJobNotCancelled(jobId);
  const clusterResult = await clusterAllPending(signal, jobId);
  assertNotAborted(signal);
  if (jobId) await assertJobNotCancelled(jobId);

  const result: Record<string, unknown> = {
    stages: {
      collect: summarizeCollectResult(collectResult),
      process: processResult,
      ai: aiResult,
      cluster: clusterResult,
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
    if (jobId) await startJobStage(jobId, { stage: 'ai', total: articleIds.length });
    let processed = 0;
    let errors = 0;
    const analyzedIds: string[] = [];
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
    let clustered = 0;
    let clusterErrors = 0;
    if (analyzedIds.length > 0 && jobId) await startJobStage(jobId, { stage: 'cluster', total: analyzedIds.length });
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
    return { articleIds, processed, errors, clustered, clusterErrors };
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
  const result: Record<string, unknown> = { articleId, startAt, intent, stages: [] as string[] };
  const stages = result.stages as string[];
  await db.article.update({ where: { id: articleId }, data: { technicalIgnoredAt: null } });

  if (startAt === 'process') {
    if (jobId) await startJobStage(jobId, { stage: 'process', total: 1, currentItemLabel: article.title });
    result.process = await refetchArticle(articleId);
    stages.push('process');
    if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
  }

  if (startAt === 'cluster') {
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
  }

  if (startAt === 'ai') {
    await prepareArticleForAiRegeneration(articleId);
  }

  if (startAt === 'process' || startAt === 'ai') {
    assertNotAborted(signal);
    if (jobId) await assertJobNotCancelled(jobId);
    result.ai = await reprocessWithAI(articleId, signal, jobId);
    stages.push('ai');
  }

  if (startAt === 'process' || startAt === 'cluster' || startAt === 'ai') {
    assertNotAborted(signal);
    if (jobId) await assertJobNotCancelled(jobId);
    const aiResult = result.ai as Awaited<ReturnType<typeof reprocessWithAI>> | undefined;
    if (startAt === 'cluster' || aiResult?.status === 'done') {
      if (jobId) await startJobStage(jobId, { stage: 'cluster', total: 1, currentItemLabel: article.title });
      result.cluster = await clusterSingleArticle(articleId, signal);
      stages.push('cluster');
      if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
    }
  } else {
    if (jobId) await startJobStage(jobId, { stage: 'push', total: 1, currentItemLabel: article.title });
    if (article.eventId) {
      await db.event.update({ where: { id: article.eventId }, data: { pushRetryCount: 0, nextPushRetryAt: null } });
    }
    result.push = await pushArticleToFeishu(articleId, 'retry_failed', signal);
    stages.push('push');
    if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
  }
  return result;
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
 * Abort the currently running job. Sets cancel_requested in DB so the worker
 * can cooperatively stop at the next stage boundary, then aborts the
 * in-memory AbortController for the current process.
 */
export async function abortRunningJob(): Promise<{ resetCount: number }> {
  const jobId = abortCurrentJob();
  if (jobId) {
    await db.job.updateMany({
      where: { id: jobId, status: 'running' },
      data: { status: 'cancel_requested', cancelRequestedAt: new Date() },
    });
    return { resetCount: 0 };
  }

  // No in-process owner — only reset orphaned running jobs with expired leases
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
 * Reset orphaned jobs whose lease has expired. Does NOT touch running jobs
 * with active leases — those belong to another instance.
 */
export async function resetOrphanedJobs(): Promise<void> {
  try {
    const now = new Date();
    const result = await db.job.updateMany({
      where: {
        status: { in: [...ACTIVE_JOB_STATUSES] },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: 'cancelled',
        error: 'Worker restarted (expired lease)',
        completedAt: now,
        heartbeatAt: now,
        leaseOwner: '',
        leaseExpiresAt: null,
      },
    });
    if (result.count > 0) {
      console.log(`[execution] reset ${result.count} orphaned job(s) with expired leases`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[execution] failed to reset orphaned jobs:', msg);
  }
}
