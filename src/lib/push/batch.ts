import { db } from '@/lib/db'
import { assertNotAborted } from '@/lib/worker-stop'
import { getPushTargetStatesForEvents, pushEventToFeishu } from '@/lib/push/delivery'
import { PUSH_MAX_RETRIES, pushableWhere, readPushSettings, type PushSettings } from '@/lib/push/policy'
import { getWebhookConfigs } from '@/lib/settings'

const PUSH_EVENT_BATCH_SIZE = 100
const PUSH_CONCURRENCY = 3

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
  let success = 0
  let failed = 0
  let skipped = 0

  // Event 推送会改变 pushedAt / nextPushRetryAt，因此每轮只取固定窗口；处理完成的
  // 记录自然离开 where。不能一次把全部积压 Event 留在 Node 内存里。
  while (true) {
    assertNotAborted(signal)
    const events = await db.event.findMany({
      where: pushableWhere(snap),
      include: { representativeArticle: { select: { score: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: PUSH_EVENT_BATCH_SIZE,
    })
    if (events.length === 0) break

    const targetStatesByEvent = await getPushTargetStatesForEvents(events.map(event => event.id))
    const unknownEventIds = events
      .filter(event => (targetStatesByEvent.get(event.id) ?? []).some(target => target.latestStatus === 'unknown'))
      .map(event => event.id)

    // 结果未知不能自动补发。把自动重试额度直接收口为终态，避免每个后续 Job
    // 都重新取到同一 Event；管理员仍可在抽屉中使用 manual_force 明确确认。
    if (unknownEventIds.length > 0) {
      await db.event.updateMany({
        where: { id: { in: unknownEventIds }, pushRetryCount: { lt: PUSH_MAX_RETRIES } },
        data: { pushRetryCount: PUSH_MAX_RETRIES, nextPushRetryAt: null },
      })
      skipped += unknownEventIds.length
      await onProgress?.(unknownEventIds.length, 0)
    }

    const unknownIds = new Set(unknownEventIds)
    const automaticEvents = events
      .filter(event => !unknownIds.has(event.id))
      .sort((left, right) => (right.representativeArticle?.score ?? 0) - (left.representativeArticle?.score ?? 0))

    for (let i = 0; i < automaticEvents.length; i += PUSH_CONCURRENCY) {
      assertNotAborted(signal)
      const batch = automaticEvents.slice(i, i + PUSH_CONCURRENCY)
      const outcomes = await Promise.allSettled(batch.map(event => pushEventToFeishu(event.id, 'normal', signal)))
      assertNotAborted(signal)
      let unexpectedError: unknown = null
      let batchFailed = 0
      let deliveryUnavailable = false
      for (const result of outcomes) {
        if (result.status === 'rejected') {
          unexpectedError ??= result.reason
          batchFailed++
          failed++
          continue
        }
        if (result.value.status === 'completed') success++
        else {
          batchFailed++
          failed++
          if (result.value.status === 'no_webhooks') deliveryUnavailable = true
        }
      }
      await onProgress?.(batch.length, batchFailed)
      // 数据库 / 程序级异常不应让 while 反复捞到同一条待推送 Event；交给 Job 的
      // 有限重试统一恢复。Webhook 在运行中被移除时则立即结束本轮，避免空转。
      if (unexpectedError) throw unexpectedError
      if (deliveryUnavailable) return { success, failed, skipped }
    }
  }
  return { success, failed, skipped }
}
