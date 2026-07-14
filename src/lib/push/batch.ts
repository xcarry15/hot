import { db } from '@/lib/db'
import { assertNotAborted } from '@/lib/worker-stop'
import { pushArticleToFeishu } from '@/lib/push/delivery'
import { pushableWhere, readPushSettings, type PushSettings } from '@/lib/push/policy'

export async function pushAllUnpushed(
  signal?: AbortSignal,
  settings?: PushSettings,
  onProgress?: (done: number, failed: number) => void | Promise<void>,
): Promise<{ success: number; failed: number }> {
  const snap = settings ?? (await readPushSettings())
  if (snap.pushMode === 'off') return { success: 0, failed: 0 }
  assertNotAborted(signal)
  const articles = await db.article.findMany({ where: pushableWhere(snap), orderBy: { score: 'desc' } })
  let success = 0
  let failed = 0
  const concurrency = 3
  for (let i = 0; i < articles.length; i += concurrency) {
    assertNotAborted(signal)
    const batch = articles.slice(i, i + concurrency)
    const outcomes = await Promise.allSettled(batch.map(a => pushArticleToFeishu(a.id, false, signal)))
    assertNotAborted(signal)
    for (const result of outcomes) {
      if (result.status === 'fulfilled' && result.value.status === 'completed') success++
      else failed++
    }
    await onProgress?.(batch.length, outcomes.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 'completed')).length)
  }
  return { success, failed }
}

