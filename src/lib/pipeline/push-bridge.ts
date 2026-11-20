import { db } from '@/lib/db'
import { pushAllUnpushed } from '@/lib/push/batch'
import { readPushSettings } from '@/lib/push/policy'
import { assertNotAborted } from '@/lib/worker-stop'
import { advanceJobProgress, startJobStage } from '@/lib/job-progress'
import { pushableWhere } from '@/lib/push/policy'
import { assertWorkerCanWrite } from '@/lib/execution-write-guard'

export interface PushExecutionOptions {
  respectQuietHours?: boolean;
}

export async function pushAllPendingArticles(
  signal?: AbortSignal,
  jobId?: string,
  options?: PushExecutionOptions,
): Promise<{ total: number; processed: number; errors: number }> {
  assertNotAborted(signal)
  const pushSettings = await readPushSettings()
  const estimate = pushSettings.pushMode === 'off' ? 0 : await db.event.count({ where: pushableWhere(pushSettings) })
  if (jobId) await startJobStage(jobId, { stage: 'push', total: estimate })
  // 真实飞书推送不可撤回：取消已写入 DB 但 signal 尚未轮询到的窗口内，
  // assertNotAborted 不足以拦截，必须查持久化执行权。
  await assertWorkerCanWrite(signal)
  const result = await pushAllUnpushed(signal, pushSettings, async (done, failed) => {
    if (!jobId) return
    await advanceJobProgress(jobId, { doneDelta: done, errorDelta: failed, currentItemLabel: '推送处理中' })
  }, options)
  return { total: result.success + result.failed + result.skipped, processed: result.success, errors: result.failed }
}
