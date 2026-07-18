import { db } from '@/lib/db'
import { assertNotAborted } from '@/lib/worker-stop'
import { pushEventToFeishu } from '@/lib/push/delivery'
import { pushableWhere, readPushSettings, type PushSettings } from '@/lib/push/policy'
import { getWebhookConfigs } from '@/lib/settings'

export async function pushAllUnpushed(
  signal?: AbortSignal,
  settings?: PushSettings,
  onProgress?: (done: number, failed: number) => void | Promise<void>,
): Promise<{ success: number; failed: number }> {
  const snap = settings ?? (await readPushSettings())
  if (snap.pushMode === 'off') return { success: 0, failed: 0 }
  const hasEnabledWebhook = (await getWebhookConfigs()).some(config => config.enabled && config.url.trim() !== '')
  if (!hasEnabledWebhook) return { success: 0, failed: 0 }
  assertNotAborted(signal)
  const events = await db.event.findMany({
    where: pushableWhere(snap),
    include: { representativeArticle: { select: { score: true } } },
    orderBy: { lastSeenAt: 'desc' },
  })
  events.sort((left, right) => (right.representativeArticle?.score ?? 0) - (left.representativeArticle?.score ?? 0))
  let success = 0
  let failed = 0
  const concurrency = 3
  for (let i = 0; i < events.length; i += concurrency) {
    assertNotAborted(signal)
    const batch = events.slice(i, i + concurrency)
    const outcomes = await Promise.allSettled(batch.map(event => pushEventToFeishu(event.id, 'normal', signal)))
    assertNotAborted(signal)
    for (const result of outcomes) {
      if (result.status === 'fulfilled' && result.value.status === 'completed') success++
      else failed++
    }
    await onProgress?.(batch.length, outcomes.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 'completed')).length)
  }
  return { success, failed }
}
