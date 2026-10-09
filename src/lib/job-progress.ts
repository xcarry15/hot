/**
 * Job 进度持久化与心跳。
 *
 * 设计约束：
 * - Job 表是任务级状态的唯一事实源。所有 Job 进度更新必须经过这里。
 * - 执行器写入校验状态、本轮领取标识及租约有效期；终态或重新领取的 Job
 *   不会被旧执行器覆盖。
 * - 进度值不允许超过 total（total=0 的未知进度除外——保留 done 计数用于不确定进度）。
 * - 心跳定时器在 finally 中清理；Job 完成/失败时也要更新 heartbeatAt 与 completedAt
 *   保持一致。
 */

import type { JobStage, Prisma } from '@prisma/client';
import { db } from './db';
import { getJobWriteWhere } from './job-context';

export type JobStageName = JobStage;

/** Job 阶段切换语义：写 currentStage + 重置 done/errors = 0。 */
export interface StartStageInput {
  stage: JobStageName;
  total: number;
  currentItemLabel?: string;
}

/** 阶段内进度推进；done/errors 增量累加；不允许超过 total（total=0 除外）。 */
export interface AdvanceProgressInput {
  doneDelta?: number;
  errorDelta?: number;
  currentItemLabel?: string;
}

/** Job 阶段快照——上层（crawler / ai / push）调用此函数推进。 */
export async function startJobStage(jobId: string, input: StartStageInput): Promise<void> {
  const total = Math.max(0, Math.floor(input.total));
  await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: 'running' },
    data: {
      currentStage: input.stage,
      progressTotal: total,
      progressDone: 0,
      progressErrors: 0,
      currentItemLabel: input.currentItemLabel ?? '',
      heartbeatAt: new Date(),
    },
  });
}

/** 累加 done/errors；total=0 时允许 done 任意累加（不确定进度）。 */
export async function advanceJobProgress(jobId: string, input: AdvanceProgressInput): Promise<void> {
  const doneDelta = Math.max(0, Math.floor(input.doneDelta ?? 0));
  const errorDelta = Math.max(0, Math.floor(input.errorDelta ?? 0));
  if (doneDelta === 0 && errorDelta === 0 && input.currentItemLabel === undefined) return;

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { progressTotal: true, progressDone: true, progressErrors: true, status: true },
  });
  if (!job || job.status !== 'running') return;

  const nextDone = job.progressDone + doneDelta;
  const nextErrors = job.progressErrors + errorDelta;
  const cappedDone = job.progressTotal > 0
    ? Math.min(nextDone, job.progressTotal)
    : nextDone;

  await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: 'running' },
    data: {
      progressDone: cappedDone,
      progressErrors: nextErrors,
      ...(input.currentItemLabel !== undefined ? { currentItemLabel: input.currentItemLabel } : {}),
      heartbeatAt: new Date(),
    },
  });
}

/** 心跳更新；前端通过快照轮询观察。 */
export async function touchJobHeartbeat(jobId: string): Promise<void> {
  await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: 'running' },
    data: { heartbeatAt: new Date() },
  });
}

/**
 * 心跳定时器。
 * - 30 秒间隔刷新 heartbeatAt；
 * - Job 已进入终态时跳过（updateMany where status=running 会 no-op）；
 * - 必须配合 stopJobHeartbeat(timer) 在 finally 中清理，避免 HMR / Job 结束后残留。
 */
export function startJobHeartbeat(jobId: string, intervalMs: number = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    void touchJobHeartbeat(jobId).catch((err) => {
      console.error(`[job-progress] heartbeat failed for job=${jobId}:`, err);
    });
  }, intervalMs);
}

export function stopJobHeartbeat(timer: NodeJS.Timeout | null): void {
  if (!timer) return;
  clearInterval(timer);
}

/**
 * 标记 Job 进入完成/失败状态——同时更新 heartbeatAt 让前端能识别最后一次心跳，
 */
async function finishRunningJob(jobId: string, result: Prisma.JobUpdateManyMutationInput): Promise<boolean> {
  const now = new Date();
  const terminal = { completedAt: now, heartbeatAt: now, leaseOwner: '', leaseExpiresAt: null };
  const updated = await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: 'running' },
    data: { ...result, ...terminal },
  });
  if (updated.count === 1) return true;
  // 最终检查与写入之间仍可能收到取消请求，必须收尾而不是留下活租约。
  await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: 'cancel_requested' },
    data: { ...terminal, status: 'cancelled', error: 'Stopped by user' },
  });
  return false;
}

export function markJobCompleted(jobId: string, result: Record<string, unknown>): Promise<boolean> {
  return finishRunningJob(jobId, { status: 'succeeded', result: JSON.stringify(result) });
}

export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  await finishRunningJob(jobId, { status: 'failed', error: errorMessage.slice(0, 2000) });
}

export async function markJobCancelled(jobId: string, reason: string): Promise<void> {
  await db.job.updateMany({
    where: { ...getJobWriteWhere(jobId), status: { in: ['running', 'cancel_requested'] } },
    data: {
      status: 'cancelled',
      error: reason.slice(0, 2000),
      completedAt: new Date(),
      heartbeatAt: new Date(),
      leaseOwner: '',
      leaseExpiresAt: null,
    },
  });
}
