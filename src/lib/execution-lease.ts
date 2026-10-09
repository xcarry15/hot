import { db } from './db';
import { CANCELLED_JOB_STATUSES, CLAIMABLE_JOB_STATUSES } from './job-status';
import { randomUUID } from 'node:crypto';
import { JobLeaseLostError, type JobExecutionLease } from './job-context';

export const JOB_LEASE_DURATION_MS = 5 * 60 * 1000;
export const JOB_CANCELLATION_POLL_INTERVAL_MS = 1_000;

function workerId(): string {
  const pid = typeof process !== 'undefined' && process.pid ? String(process.pid) : '0';
  const host = typeof process !== 'undefined' && process.env?.HOSTNAME
    ? process.env.HOSTNAME
    : 'local';
  return `${host}:${pid}:${randomUUID()}`;
}

/** 通过数据库条件更新原子领取 Job，避免同一 Job 被多个 worker 执行。 */
export async function claimJob(jobId: string): Promise<JobExecutionLease | null> {
  const owner = workerId();
  const now = new Date();
  const leaseExpires = new Date(now.getTime() + JOB_LEASE_DURATION_MS);
  try {
    const updated = await db.job.updateMany({
      where: {
        id: jobId,
        status: { in: [...CLAIMABLE_JOB_STATUSES] },
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
          { OR: [{ availableAt: null }, { availableAt: { lte: now } }] },
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
        cancelRequestedAt: null,
        attempt: { increment: 1 },
      },
    });
    return updated.count === 1 ? { jobId, owner } : null;
  } catch (error) {
    console.error('[execution-lease] claim failed:', error);
    return null;
  }
}

export async function renewJobLease(lease: JobExecutionLease): Promise<boolean> {
  const now = new Date();
  const updated = await db.job.updateMany({
    where: { id: lease.jobId, status: 'running', leaseOwner: lease.owner, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_DURATION_MS), heartbeatAt: now },
  });
  return updated.count === 1;
}

/** 跨模块实例轮询数据库，使 stop 路由的 cancel_requested 能中止实际执行器。 */
export function startJobCancellationWatcher(
  lease: JobExecutionLease,
  controller: AbortController,
  isRunnerCurrent: () => Promise<boolean>,
): { stop(): void } {
  const jobId = lease.jobId;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const poll = async () => {
    try {
      const [job, runnerCurrent] = await Promise.all([
        db.job.findUnique({ where: { id: jobId }, select: { status: true, leaseOwner: true, leaseExpiresAt: true } }),
        isRunnerCurrent(),
      ]);
      if (!stopped && !controller.signal.aborted) {
        if (!runnerCurrent || !job || job.leaseOwner !== lease.owner || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) {
          controller.abort(new JobLeaseLostError());
        } else if (CANCELLED_JOB_STATUSES.includes(job.status)) {
          controller.abort(new Error('Job cancelled'));
        } else if (job.status !== 'running') {
          controller.abort(new JobLeaseLostError());
        }
      }
    } catch (error) {
      console.error(`[execution-lease] cancellation check failed for ${jobId}:`, error);
    } finally {
      if (!stopped && !controller.signal.aborted) timer = setTimeout(() => { void poll(); }, JOB_CANCELLATION_POLL_INTERVAL_MS);
    }
  };
  timer = setTimeout(() => { void poll(); }, JOB_CANCELLATION_POLL_INTERVAL_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
