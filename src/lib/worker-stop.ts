/**
 * Worker stop / cancellation utilities.
 *
 * Single-process model: a shared AbortController gives immediate-ish
 * cancellation (the current loop iteration finishes, then the next check sees
 * signal.aborted and throws).
 *
 * The cross-process Setting-flag stop mechanism (for a standalone worker) was
 * removed — the standalone worker mode is obsolete (SSE doesn't work cross-
 * process). All execution entry points now register their controller here.
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
  activeJob.controller.abort();
  return activeJob.jobId;
}

/** Convenience guard for long-running loops. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Stopped by user');
  }
}
