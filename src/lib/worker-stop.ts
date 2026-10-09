/**
 * 当前进程的 Job 取消控制器。执行入口注册控制器，长循环在写入或下一项前检查信号。
 * 数据库取消请求及本轮租约由 execution-lease 轮询，覆盖不同模块实例和进程。
 */

interface ActiveJobController {
  jobId: string;
  controller: AbortController;
}

let activeJob: ActiveJobController | null = null;

export function createJobAbortController(jobId: string): AbortController {
  if (activeJob) {
    throw new Error(`Job controller already active: ${activeJob.jobId}`);
  }
  const controller = new AbortController();
  activeJob = { jobId, controller };
  return controller;
}

export function clearJobAbortController(jobId: string): void {
  if (activeJob?.jobId === jobId) {
    activeJob = null;
  }
}

/** Abort the currently running job (in-process). */
export function abortCurrentJob(): string | null {
  if (!activeJob) return null;
  activeJob.controller.abort(new Error('Stopped by user'));
  return activeJob.jobId;
}

/** Convenience guard for long-running loops. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Stopped by user');
  }
}
