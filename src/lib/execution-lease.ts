import { db } from './db';
import { CLAIMABLE_JOB_STATUSES } from './job-status';

export const JOB_LEASE_DURATION_MS = 5 * 60 * 1000;
export const JOB_CANCELLATION_POLL_INTERVAL_MS = 1_000;

function workerId(): string {
  const pid = typeof process !== 'undefined' && process.pid ? String(process.pid) : '0';
  const host = typeof process !== 'undefined' && process.env?.HOSTNAME
    ? process.env.HOSTNAME
    : 'local';
  return `${host}:${pid}`;
}

/** 通过数据库条件更新原子领取 Job，避免同一 Job 被多个 worker 执行。 */
export async function claimJob(jobId: string): Promise<boolean> {
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
        attempt: { increment: 1 },
      },
    });
    return updated.count > 0;
  } catch (error) {
    console.error('[execution-lease] claim failed:', error);
    return false;
  }
}

export async function renewJobLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const updated = await db.job.updateMany({
    where: { id: jobId, status: 'running', leaseOwner: workerId() },
    data: { leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_DURATION_MS), heartbeatAt: now },
  });
  return updated.count === 1;
}

/** 跨模块实例轮询数据库，使 stop 路由的 cancel_requested 能中止实际执行器。 */
export function startJobCancellationWatcher(jobId: string, controller: AbortController): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const poll = async () => {
    try {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if ((job?.status === 'cancel_requested' || job?.status === 'cancelled') && !controller.signal.aborted) {
        controller.abort(new Error('Job cancelled'));
      }
    } catch (error) {
      console.error(`[execution-lease] cancellation check failed for ${jobId}:`, error);
    } finally {
      if (!stopped) timer = setTimeout(() => { void poll(); }, JOB_CANCELLATION_POLL_INTERVAL_MS);
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
