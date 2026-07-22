/**
 * Event 级 push delivery with PushDelivery Ledger (P0-4).
 *
 * 职责：
 *   - 使用 PushDelivery 记录作为持久化防重依据（替代 inFlightPushes Map）
 *   - 发送前创建 sending Delivery，发送后更新为 succeeded/failed
 *   - 发送结果未知（HTTP ok 但 DB 写入失败）标记为 unknown，禁止自动重发
 *   - PushTarget 通过 urlHash 解析，不再在 PushLog 中保留明文 Webhook URL
 */

import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { assertNotAborted } from '@/lib/worker-stop';
import { getRelatedArticles } from '@/lib/article-related-service';
import { getWebhookConfigs, type WebhookConfig } from '@/lib/settings';
import { findRecentPushedEventDuplicate } from '@/lib/event-clustering-service';
import { PUSH_MAX_RETRIES, PUSH_RETRY_DELAY_MS, readPushSettings } from '@/lib/push/policy';
import { getPushUrgency, buildFeishuCard } from '@/lib/push/feishu-card';
import { sendFeishuWebhook } from '@/lib/push/feishu-transport';
import { getEventReleaseBlockReason, type EventReleaseBlockReason } from '@/lib/event-release-policy';

export type PushDeliveryMode = 'normal' | 'retry_failed' | 'manual_force' | 'repush_all';

const DELIVERY_LEASE_DURATION_MS = 120_000;

export interface PushTargetState {
  webhookUrl: string;
  webhookRemark: string;
  latestStatus: 'success' | 'failure' | 'never_attempted' | 'unknown';
  latestCreatedAt: Date | null;
}

export interface PushArticleResult {
  status: 'completed' | 'partial' | 'failed' | 'no_webhooks';
  mode: PushDeliveryMode;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  message: string;
}

function computeUrlHash(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex').slice(0, 16);
}

/** Find or create a PushTarget for a given webhook config. */
async function resolvePushTarget(config: WebhookConfig): Promise<{ id: string; name: string; urlHash: string }> {
  const urlHash = computeUrlHash(config.url);
  const existing = await db.pushTarget.findUnique({ where: { urlHash }, select: { id: true, name: true, urlHash: true } });
  if (existing) {
    if (existing.name !== (config.remark || config.url)) {
      await db.pushTarget.update({ where: { id: existing.id }, data: { name: config.remark || config.url } });
    }
    return existing;
  }
  return db.pushTarget.create({
    data: { name: config.remark || config.url, urlHash, enabled: config.enabled },
    select: { id: true, name: true, urlHash: true },
  });
}

function contentVersion(article: {
  id: string;
  title: string;
  summary?: string;
  brand?: string;
  category?: string;
  score: number;
  relevance: number;
  keyPoints?: string;
  isAd: boolean;
  originalSource?: string | null;
  source?: { name: string } | null;
  updatedAt?: Date | null;
}): string {
  const sourceName = article.originalSource || article.source?.name || '';
  return createHash('sha256')
    .update(`${article.id}|${article.title}|${article.summary || ''}|${article.brand || ''}|${article.category || ''}|${article.score}|${article.relevance}|${article.keyPoints || ''}|${article.isAd ? '1' : '0'}|${sourceName}`)
    .digest('hex').slice(0, 12);
}

export async function getPushTargetStatesForEvents(eventIds: string[]): Promise<Map<string, PushTargetState[]>> {
  const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
  const result = new Map(uniqueEventIds.map((eventId) => [eventId, [] as PushTargetState[]]));
  if (uniqueEventIds.length === 0) return result;

  const enabled = Array.from(new Map((await getWebhookConfigs())
    .filter((config) => config.enabled && config.url.trim())
    .map((config) => [config.url.trim(), { ...config, url: config.url.trim() }])).values());
  if (enabled.length === 0) return result;

  const urlHashes = enabled.map((config) => computeUrlHash(config.url));
  const targets = await db.pushTarget.findMany({
    where: { urlHash: { in: urlHashes } },
    select: { id: true, urlHash: true },
  });
  const targetByHash = new Map(targets.map((target) => [target.urlHash, target.id]));

  // Use PushDelivery for latest per-target state
  const deliveries = await db.pushDelivery.findMany({
    where: { eventId: { in: uniqueEventIds }, targetId: { in: targets.map((target) => target.id) } },
    orderBy: { createdAt: 'desc' },
    select: { eventId: true, targetId: true, status: true, createdAt: true, leaseExpiresAt: true },
  });

  const latest = new Map<string, typeof deliveries[number]>();
  for (const delivery of deliveries) {
    const key = `${delivery.eventId}\u0000${delivery.targetId}`;
    if (!latest.has(key)) latest.set(key, delivery);
  }

  for (const eventId of uniqueEventIds) {
    result.set(eventId, enabled.map((config) => {
      const targetId = targetByHash.get(computeUrlHash(config.url));
      const delivery = targetId ? latest.get(`${eventId}\u0000${targetId}`) : undefined;
      let latestStatus: PushTargetState['latestStatus'] = 'never_attempted';
      if (delivery) {
        if (delivery.status === 'succeeded') latestStatus = 'success';
        else if (delivery.status === 'unknown' || delivery.status === 'sending') latestStatus = 'unknown';
        else latestStatus = 'failure';
      }
      return {
        webhookUrl: config.url,
        webhookRemark: config.remark || '',
        latestStatus,
        latestCreatedAt: delivery?.createdAt ?? null,
      };
    }));
  }
  return result;
}

export async function getPushTargetStates(eventId: string): Promise<PushTargetState[]> {
  return (await getPushTargetStatesForEvents([eventId])).get(eventId) ?? [];
}

export async function getFailedPushTargets(eventId: string): Promise<PushTargetState[]> {
  return (await getPushTargetStates(eventId)).filter(
    (target) => target.latestStatus === 'failure' || target.latestStatus === 'unknown',
  );
}

/**
 * P2: 将过期 sending Delivery 标记为 unknown。
 * 只能由定时维护、Job 启动前、人工推送前调用，读取路径不触发写操作。
 */
export async function cleanupExpiredSendingDeliveries(): Promise<number> {
  const now = new Date();
  const result = await db.pushDelivery.updateMany({
    where: {
      status: 'sending',
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: 'unknown',
      lastError: '投递租约已过期，结果未知；需要人工强制推送确认',
      completedAt: now,
      leaseOwner: '',
      leaseExpiresAt: null,
    },
  });
  if (result.count > 0) {
    console.log(`[push] cleaned up ${result.count} expired sending deliveries`);
  }
  return result.count;
}

/** Push a single article to all enabled Feishu webhooks. */
export function pushArticleToFeishu(
  articleId: string,
  mode: PushDeliveryMode = 'normal',
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  return db.article.findUnique({ where: { id: articleId }, select: { eventId: true } }).then((article) => {
    if (!article?.eventId) return emptyPushResult(mode, 'failed', '文章尚未完成事件聚类');
    return pushEventToFeishu(article.eventId, mode, signal);
  });
}

export function pushEventToFeishu(
  eventId: string,
  mode: PushDeliveryMode = 'normal',
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  return pushEventToFeishuInternal(eventId, mode, signal);
}

async function pushEventToFeishuInternal(
  eventId: string,
  mode: PushDeliveryMode,
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  assertNotAborted(signal);
  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { representativeArticle: { include: { source: { select: { name: true, deletedAt: true } } } } },
  });
  if (!event || !event.representativeArticle) return emptyPushResult(mode, 'failed', '事件或代表文章不存在');
  const article = event.representativeArticle;
  const releaseBlock = getEventReleaseBlockReason(event, article.id, article);
  if (releaseBlock) {
    const messages: Record<EventReleaseBlockReason, string> = {
      'event-not-active': '事件不是 active 状态，不能推送',
      'event-needs-review': '事件仍待聚类复核，不能推送',
      'representative-missing': '事件缺少代表文章，不能推送',
      'article-not-representative': '当前文章不是事件代表文章，不能推送',
      'cluster-not-done': '文章尚未完成事件聚类，不能推送',
      'ai-not-done': '代表文章尚未完成 AI 分析，不能推送',
      'source-deleted': '代表文章来源已删除，不能推送',
    };
    return emptyPushResult(mode, 'failed', messages[releaseBlock]);
  }

  if (mode === 'retry_failed' && event.nextPushRetryAt && event.nextPushRetryAt > new Date()) {
    return emptyPushResult(mode, 'failed', `推送重试等待中，可重试时间: ${event.nextPushRetryAt.toISOString()}`);
  }

  if (mode === 'normal' || mode === 'retry_failed') {
    const settings = await readPushSettings();
    if (settings.pushMode === 'off') {
      return emptyPushResult(mode, 'failed', '当前推送模式已关闭');
    }
    if (article.score < settings.minScore || article.relevance < settings.minRelevance) {
      return emptyPushResult(mode, 'failed', '文章未达到推送阈值');
    }
  }

  const configs = await getWebhookConfigs();
  const enabled = Array.from(
    new Map(
      configs
        .filter((c) => c.enabled && c.url.trim() !== '')
        .map((c) => [c.url.trim(), { ...c, url: c.url.trim() }]),
    ).values(),
  );
  if (enabled.length === 0) {
    return emptyPushResult(mode, 'no_webhooks', '没有配置启用的 Feishu Webhook URL');
  }

  if (mode === 'normal' && !event.pushedAt) {
    const duplicate = await findRecentPushedEventDuplicate(article.id, eventId);
    if (duplicate) {
      await db.event.update({
        where: { id: eventId },
        data: { pushRetryCount: PUSH_MAX_RETRIES, nextPushRetryAt: null },
      });
      return emptyPushResult(mode, 'failed', `疑似与最近已推送 Event 重复，已阻止推送（${duplicate.eventId}）`);
    }
  }

  // Resolve all PushTargets
  const targets = await Promise.all(enabled.map((config) => resolvePushTarget(config)));
  const targetByUrl = new Map(targets.map((target, index) => [enabled[index].url, target]));

  // P0-4: Check existing deliveries before pushing — DB-level dedup
  const cVersion = contentVersion(article);
  const existingDeliveries = await db.pushDelivery.findMany({
    where: { eventId, targetId: { in: targets.map((target) => target.id) }, contentVersion: cVersion, mode },
    select: { targetId: true, status: true },
  });
  const succeededTargets = new Set(
    existingDeliveries.filter((del) => del.status === 'succeeded').map((del) => del.targetId),
  );
  const unknownTargets = new Set(
    existingDeliveries.filter((del) => del.status === 'unknown').map((del) => del.targetId),
  );

  // Determine which targets to actually send to
  const targetStates = await getPushTargetStates(eventId);
  const selectedUrls = new Set(targetStates.filter((target) => {
    if (mode === 'repush_all') return true;
    if (mode === 'retry_failed') return target.latestStatus === 'failure';
    // P0-4: unknown 状态不得自动重新发送
    if (target.latestStatus === 'unknown' && mode !== 'manual_force') return false;
    return target.latestStatus !== 'success';
  }).map((target) => target.webhookUrl));

  if (mode === 'retry_failed' && selectedUrls.size === 0) {
    return emptyPushResult(mode, 'failed', '当前没有失败的推送目标', enabled.length);
  }
  if (mode === 'normal' && event.pushedAt && selectedUrls.size === 0) {
    return emptyPushResult(mode, 'completed', '该事件已完整推送', enabled.length);
  }

  const urgency = getPushUrgency(article);
  const relatedArticles = (await getRelatedArticles(article.id, 3, { onlyPushed: true })) ?? [];
  const card = buildFeishuCard(
    { ...article, publicEventId: eventId },
    urgency,
    { relatedArticles },
  );

  let attemptSucceeded = 0;
  for (const config of enabled) {
    assertNotAborted(signal);
    if (!selectedUrls.has(config.url)) continue;

    const target = targetByUrl.get(config.url);
    if (!target) continue;

    // Skip already-succeeded deliveries for normal/retry_failed mode
    if (mode !== 'manual_force' && mode !== 'repush_all' && succeededTargets.has(target.id)) continue;

    // P0-4: Don't auto-retry unknown deliveries
    if (mode !== 'manual_force' && unknownTargets.has(target.id)) continue;

    const ok = await pushToSingleTarget(
      eventId, article.id, target.id, config, cVersion, mode, card, signal,
    );
    if (ok) attemptSucceeded++;
  }

  const finalStates = await getPushTargetStates(eventId);
  const allSucceeded = mode === 'repush_all'
    ? attemptSucceeded > 0 && attemptSucceeded === enabled.length
    : finalStates.length > 0 && finalStates.every(
        (target) => target.latestStatus === 'success',
      );
  const failedCount = selectedUrls.size - attemptSucceeded;
  const skipped = enabled.length - selectedUrls.size;

  if (allSucceeded) {
    await db.event.update({
      where: { id: eventId },
      data: { pushedAt: new Date(), nextPushRetryAt: null, pushRetryCount: 0 },
    });
    return { status: 'completed', mode, attempted: selectedUrls.size, succeeded: attemptSucceeded, failed: 0, skipped, message: `已完成 ${selectedUrls.size} 个目标投递` };
  }

  const nextRetryCount = event.pushRetryCount + 1;
  await db.event.update({
    where: { id: eventId },
    data: {
      pushRetryCount: nextRetryCount,
      nextPushRetryAt: nextRetryCount >= PUSH_MAX_RETRIES ? null : new Date(Date.now() + PUSH_RETRY_DELAY_MS),
    },
  });

  if (attemptSucceeded > 0) {
    return { status: 'partial', mode, attempted: selectedUrls.size, succeeded: attemptSucceeded, failed: failedCount, skipped, message: `${attemptSucceeded} 成功, ${failedCount} 失败` };
  }
  return { status: 'failed', mode, attempted: selectedUrls.size, succeeded: 0, failed: failedCount, skipped, message: `全部 ${failedCount} 个 Webhook 推送失败` };
}

function emptyPushResult(mode: PushDeliveryMode, status: PushArticleResult['status'], message: string, skipped = 0): PushArticleResult {
  return { status, mode, attempted: 0, succeeded: 0, failed: 0, skipped, message };
}

/**
 * P0-4: Push to a single target using the PushDelivery ledger.
 * Creates a sending delivery before the webhook call, then updates to succeeded/failed/unknown.
 */
async function pushToSingleTarget(
  eventId: string,
  representativeArticleId: string,
  targetId: string,
  config: WebhookConfig,
  contentVersionStr: string,
  mode: PushDeliveryMode,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const idempotencyKey = `${eventId}:${targetId}:${contentVersionStr}:${mode}`;
  const leaseOwner = getDeliveryLeaseOwner();
  const leaseExpiresAt = new Date(Date.now() + DELIVERY_LEASE_DURATION_MS);

  // Ensure the unique ledger row exists without overwriting an active owner.
  const delivery = await db.pushDelivery.upsert({
    where: { eventId_targetId_contentVersion_mode: { eventId, targetId, contentVersion: contentVersionStr, mode } },
    create: {
      eventId,
      targetId,
      representativeArticleId,
      contentVersion: contentVersionStr,
      mode,
      status: 'sending',
      idempotencyKey,
      attempt: 1,
      leaseOwner,
      leaseExpiresAt,
    },
    update: {},
  });

  const ownsCreatedDelivery = delivery.status === 'sending' && delivery.leaseOwner === leaseOwner;
  if (!ownsCreatedDelivery) {
    const retryableStatuses =
      mode === 'repush_all'
        ? ['pending', 'failed', 'unknown', 'succeeded']
        : mode === 'manual_force'
          ? ['pending', 'failed', 'unknown']
          : ['pending', 'failed'];
    const claimed = await db.pushDelivery.updateMany({
      where: {
        eventId,
        targetId,
        contentVersion: contentVersionStr,
        mode,
        OR: [
          { status: { in: retryableStatuses } },
          {
            status: 'sending',
            OR: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lt: new Date() } },
            ],
          },
        ],
      },
      data: {
        status: 'sending',
        representativeArticleId,
        attempt: { increment: 1 },
        lastError: '',
        leaseOwner,
        leaseExpiresAt,
        completedAt: null,
      },
    });
    if (claimed.count === 0) return false;
  }

  // Send to webhook
  const result = await sendFeishuWebhook(config, card, signal);

  if (result.ok) {
    try {
      const settled = await db.pushDelivery.updateMany({
        where: { idempotencyKey, status: 'sending', leaseOwner },
        data: { status: 'succeeded', sentAt: new Date(), completedAt: new Date(), leaseOwner: '', leaseExpiresAt: null },
      });
      if (settled.count === 0) return false;
    } catch (error) {
      await markDeliveryUnknown(idempotencyKey, leaseOwner, error);
      return true;
    }
    try {
      await db.pushLog.create({
        data: {
          eventId,
          representativeArticleId,
          targetId,
          status: 'success',
          retryCount: result.retryCount,
          webhookRemark: config.remark,
        },
      });
    } catch (error) {
      // PushDelivery 已经是当前状态事实源，历史日志写失败不能把成功降级为 unknown。
      console.error('[push] failed to write success PushLog:', error);
    }
    return true;
  }

  try {
    await db.pushDelivery.updateMany({
      where: { idempotencyKey, status: 'sending', leaseOwner },
      data: {
        status: 'failed',
        lastError: (result.errorMessage ?? 'Push request failed').slice(0, 1000),
        completedAt: new Date(),
        leaseOwner: '',
        leaseExpiresAt: null,
      },
    });
  } catch (error) {
    console.error('[push] failed to record failed delivery:', error);
  }
  try {
    await db.pushLog.create({
      data: {
        eventId,
        representativeArticleId,
        targetId,
        status: 'failure',
        errorMessage: result.errorMessage ?? 'Push request failed',
        retryCount: result.retryCount,
        webhookRemark: config.remark,
      },
    });
  } catch (error) {
    console.error('[push] failed to write failure PushLog:', error);
  }
  return false;
}

function getDeliveryLeaseOwner(): string {
  const host = typeof process !== 'undefined' && process.env?.HOSTNAME ? process.env.HOSTNAME : 'local';
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  return `push:${host}:${pid}:${Math.random().toString(36).slice(2)}`;
}

async function markDeliveryUnknown(idempotencyKey: string, leaseOwner: string, error: unknown): Promise<void> {
  try {
    await db.pushDelivery.updateMany({
      where: { idempotencyKey, status: 'sending', leaseOwner },
      data: {
        status: 'unknown',
        lastError: 'DB write failed after successful webhook delivery',
        completedAt: new Date(),
        leaseOwner: '',
        leaseExpiresAt: null,
      },
    });
  } catch (markError) {
    console.error('[push] failed to mark delivery as unknown:', error, markError);
  }
}
