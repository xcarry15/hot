/**
 * Job context — propagates the current Job ID through async call chains
 * using Node.js AsyncLocalStorage.
 *
 * This lets progress emitters (src/lib/progress.ts) automatically tag every
 * SSE event with the job that produced it, without threading a jobId argument
 * through every crawler/AI/push helper.
 */

import { AsyncLocalStorage } from 'async_hooks';

const jobContext = new AsyncLocalStorage<string>();

/**
 * Run the given function inside a job context. All progress events emitted
 * within fn (and any async calls it makes) will implicitly carry this jobId.
 */
export function runWithJobId<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  return jobContext.run(jobId, fn);
}

/**
 * Get the jobId for the current async context, if any.
 */
export function getCurrentJobId(): string | undefined {
  return jobContext.getStore();
}
