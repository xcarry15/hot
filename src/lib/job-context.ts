import { AsyncLocalStorage } from 'async_hooks';

export interface JobExecutionLease {
  readonly jobId: string;
  readonly owner: string;
}

interface JobContext {
  jobId: string;
  leaseOwner: string;
  isRunnerCurrent?: () => Promise<boolean>;
}

export class JobLeaseLostError extends Error {
  constructor() {
    super('Job execution lease lost');
    this.name = 'JobLeaseLostError';
  }
}

// 同一异步调用链共享任务 ID 与本轮领取标识，日志、进度及终态使用同一所有权。
const jobContext = new AsyncLocalStorage<JobContext>();

export function runWithJobLease<T>(lease: JobExecutionLease, fn: () => Promise<T>, isRunnerCurrent?: () => Promise<boolean>): Promise<T> {
  return jobContext.run({ jobId: lease.jobId, leaseOwner: lease.owner, isRunnerCurrent }, fn);
}

export async function assertJobRunnerCurrent(): Promise<void> {
  const check = jobContext.getStore()?.isRunnerCurrent;
  if (check && !await check()) throw new JobLeaseLostError();
}

/**
 * Get the jobId for the current async context, if any.
 */
export function getCurrentJobId(): string | undefined {
  return jobContext.getStore()?.jobId;
}

export function getJobLeaseOwner(jobId: string): string | undefined {
  const current = jobContext.getStore();
  return current?.jobId === jobId ? current.leaseOwner : undefined;
}

/** 所有执行器写入都必须属于本轮有效领取；无租约上下文时拒绝写入。 */
export function getJobWriteWhere(jobId: string) {
  const leaseOwner = getJobLeaseOwner(jobId);
  if (!leaseOwner) throw new JobLeaseLostError();
  return { id: jobId, leaseOwner, leaseExpiresAt: { gt: new Date() } };
}
