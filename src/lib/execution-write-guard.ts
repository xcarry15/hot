import { assertJobNotCancelled } from '@/lib/execution-cancellation';
import { getCurrentJobId } from '@/lib/job-context';
import { assertNotAborted } from '@/lib/worker-stop';

/** 业务写入前直接核对持久化执行权，不能只等待下一次取消轮询。 */
export async function assertWorkerCanWrite(signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  const jobId = getCurrentJobId();
  if (jobId) await assertJobNotCancelled(jobId);
  assertNotAborted(signal);
}
