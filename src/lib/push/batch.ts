import { db } from '@/lib/db'
import { assertNotAborted } from '@/lib/worker-stop'
import { getPushTargetStatesForEvents, pushEventToFeishu } from '@/lib/push/delivery'
import { pushableWhere, readPushSettings, type PushSettings } from '@/lib/push/policy'
import { getWebhookConfigs } from '@/lib/settings'

export async function pushAllUnpushed(
  signal?: AbortSignal,
  settings?: PushSettings,
  onProgress?: (done: number, failed: number) => void | Promise<void>,
): Promise<{ success: number; failed: number; skipped: number }> {
  const snap = settings ?? (await readPushSettings())
  if (snap.pushMode === 'off') return { success: 0, failed: 0, skipped: 0 }
  const hasEnabledWebhook = (await getWebhookConfigs()).some(config => config.enabled && config.url.trim() !== '')
  if (!hasEnabledWebhook) return { success: 0, failed: 0, skipped: 0 }
  assertNotAborted(signal)
  const events = await db.event.findMany({
    where: pushableWhere(snap),
    include: { representativeArticle: { select: { score: true } } },
    orderBy: { lastSeenAt: 'desc' },
  })
  const targetStatesByEvent = await getPushTargetStatesForEvents(events.map(event => event.id))
  // 任一目标结果未知时，不能把同一 Event 继续交给自动推送；
  // 管理员需在文章工作台明确确认后使用 manual_force。
  const automaticEvents = events.filter(event => !(targetStatesByEvent.get(event.id) ?? []).some(target => target.latestStatus === 'unknown'))
  const skipped = events.length - automaticEvents.length
  if (skipped > 0) await onProgress?.(skipped, 0)
  automaticEvents.sort((left, right) => (right.representativeArticle?.score ?? 0) - (left.representativeArticle?.score ?? 0))
  let success = 0
  let failed = 0
  const concurrency = 3
  for (let i = 0; i < automaticEvents.length; i += concurrency) {
    assertNotAborted(signal)
    const batch = automaticEvents.slice(i, i + concurrency)
    const outcomes = await Promise.allSettled(batch.map(event => pushEventToFeishu(event.id, 'normal', signal)))
    assertNotAborted(signal)
    for (const result of outcomes) {
      if (result.status === 'fulfilled' && result.value.status === 'completed') success++
      else failed++
    }
    await onProgress?.(batch.length, outcomes.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 'completed')).length)
  }
  return { success, failed, skipped }
}
