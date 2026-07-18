import { db } from '@/lib/db'
import { pushAllUnpushed } from '@/lib/push/batch'
import { readPushSettings } from '@/lib/push/policy'
import { assertNotAborted } from '@/lib/worker-stop'
import { advanceJobProgress, startJobStage } from '@/lib/job-progress'
import { pushableWhere } from '@/lib/push/policy'

export async function pushAllPendingArticles(signal?: AbortSignal, jobId?: string): Promise<{ total: number; processed: number; errors: number }> {
  assertNotAborted(signal)
  const pushSettings = await readPushSettings()
  const estimate = pushSettings.pushMode === 'off' ? 0 : await db.event.count({ where: pushableWhere(pushSettings) })
  if (jobId) await startJobStage(jobId, { stage: 'push', total: estimate })
  assertNotAborted(signal)
  const result = await pushAllUnpushed(signal, pushSettings, async (done, failed) => {
    if (!jobId) return
    void advanceJobProgress(jobId, { doneDelta: done, errorDelta: failed, currentItemLabel: '推送处理中' })
  })
  return { total: result.success + result.failed, processed: result.success, errors: result.failed }
}
