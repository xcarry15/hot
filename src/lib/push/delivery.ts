/**
 * Event 级 push delivery。
 *
 * 职责：
 *   - 同一 eventId 同一时刻只允许一次推送（inFlightPushes 锁）
 *   - 在 PushLog 中按目标级记录成功/失败事实；部分成功重试只补未成功 URL
 *   - 推送结束后根据全部目标结果更新 Event.pushedAt / nextPushRetryAt
 *
 * 不依赖 Next.js / Route，调用方为批量推送、单篇工作流与 Event 级人工推送。
 */
import { db } from '@/lib/db';
import { assertNotAborted } from '@/lib/worker-stop';
import { getRelatedArticles } from '@/lib/article-related-service';
import { getWebhookConfigs, type WebhookConfig } from '@/lib/settings';
import { PUSH_MAX_RETRIES, PUSH_RETRY_DELAY_MS, readPushSettings } from '@/lib/push/policy';
import { getPushUrgency, buildFeishuCard } from '@/lib/push/feishu-card';
import { sendFeishuWebhook } from '@/lib/push/feishu-transport';

/** 同 eventId 并发防重；同一时刻只允许一次推送尝试。 */
const inFlightPushes = new Map<string, Promise<PushArticleResult>>();

export type PushDeliveryMode = 'normal' | 'retry_failed' | 'repush_all';

export interface PushTargetState {
  webhookUrl: string;
  webhookRemark: string;
  latestStatus: 'success' | 'failure' | 'never_attempted';
  latestCreatedAt: Date | null;
}

/** 推送结果：区分全部成功/部分成功/全部失败/无 Webhook */
export interface PushArticleResult {
  status: 'completed' | 'partial' | 'failed' | 'no_webhooks';
  mode: PushDeliveryMode;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  message: string;
}

export async function getPushTargetStatesForEvents(eventIds: string[]): Promise<Map<string, PushTargetState[]>> {
  const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
  const result = new Map(uniqueEventIds.map((eventId) => [eventId, [] as PushTargetState[]]));
  if (uniqueEventIds.length === 0) return result;
  const enabled = Array.from(new Map((await getWebhookConfigs())
    .filter((config) => config.enabled && config.url.trim())
    .map((config) => [config.url.trim(), { ...config, url: config.url.trim() }])).values());
  if (enabled.length === 0) return result;
  const logs = await db.pushLog.findMany({
    where: { eventId: { in: uniqueEventIds }, webhookUrl: { in: enabled.map((config) => config.url) } },
    orderBy: { createdAt: 'desc' },
    select: { eventId: true, webhookUrl: true, webhookRemark: true, status: true, createdAt: true },
  });
  const latest = new Map<string, typeof logs[number]>();
  for (const log of logs) {
    const key = `${log.eventId}\u0000${log.webhookUrl}`;
    if (!latest.has(key)) latest.set(key, log);
  }
  for (const eventId of uniqueEventIds) {
    result.set(eventId, enabled.map((config) => {
      const log = latest.get(`${eventId}\u0000${config.url}`);
      return {
        webhookUrl: config.url,
        webhookRemark: config.remark || log?.webhookRemark || '',
        latestStatus: log?.status === 'success' ? 'success' : log?.status === 'failure' ? 'failure' : 'never_attempted',
        latestCreatedAt: log?.createdAt ?? null,
      };
    }));
  }
  return result;
}

export async function getPushTargetStates(eventId: string): Promise<PushTargetState[]> {
  return (await getPushTargetStatesForEvents([eventId])).get(eventId) ?? [];
}

export async function getFailedPushTargets(eventId: string): Promise<PushTargetState[]> {
  return (await getPushTargetStates(eventId)).filter((target) => target.latestStatus === 'failure');
}

/** Push a single article to all enabled Feishu webhooks.
 *  Each webhook gets its own PushLog entry (with webhookUrl + webhookRemark).
 *  @returns PushArticleResult with detailed status
 */
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
  const existing = inFlightPushes.get(eventId);
  if (existing) return existing;

  const task = pushEventToFeishuInternal(eventId, mode, signal).finally(() => {
    if (inFlightPushes.get(eventId) === task) inFlightPushes.delete(eventId);
  });
  inFlightPushes.set(eventId, task);
  return task;
}

/** 暴露给其他模块/测试读取当前 in-flight 状态。 */
export function getInFlightPushes(): ReadonlyMap<string, Promise<PushArticleResult>> {
  return inFlightPushes;
}

async function pushEventToFeishuInternal(
  eventId: string,
  mode: PushDeliveryMode,
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  assertNotAborted(signal);
  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { representativeArticle: { include: { source: { select: { name: true } } } } },
  });
  if (!event || event.status !== 'active' || !event.representativeArticle) return emptyPushResult(mode, 'failed', '事件或代表文章不存在');
  const article = event.representativeArticle;
  if (article.clusterStatus !== 'clustered') {
    return emptyPushResult(mode, 'failed', '文章尚未完成事件聚类，不能推送');
  }
  if (article.aiStatus !== 'done') {
    return emptyPushResult(mode, 'failed', '代表文章尚未完成 AI 分析，不能推送');
  }

  if (mode === 'retry_failed' && event.nextPushRetryAt && event.nextPushRetryAt > new Date()) {
    return emptyPushResult(mode, 'failed', `推送重试等待中，可重试时间: ${event.nextPushRetryAt.toISOString()}`);
  }

  if (mode !== 'repush_all') {
    const settings = await readPushSettings();
    if (settings.pushMode === 'off') {
      return emptyPushResult(mode, 'failed', '当前推送模式已关闭');
    }
    if (article.score < settings.minScore || article.relevance < settings.minRelevance) {
      return emptyPushResult(mode, 'failed', '文章未达到推送阈值');
    }
  }

  // 读取所有启用的 webhook 配置
  const configs = await getWebhookConfigs();
  // URL is the stable destination identity in the current settings model.
  // Deduplicate accidental duplicate entries so one article is never sent
  // twice to the same webhook in a single attempt.
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

  const targetStates = await getPushTargetStates(eventId);
  const selectedUrls = new Set(targetStates.filter((target) => mode === 'repush_all'
    || (mode === 'retry_failed' ? target.latestStatus === 'failure' : target.latestStatus !== 'success')).map((target) => target.webhookUrl));
  if (mode === 'retry_failed' && selectedUrls.size === 0) {
    return emptyPushResult(mode, 'failed', '当前没有失败的推送目标', enabled.length);
  }
  if (mode === 'normal' && event.pushedAt && selectedUrls.size === 0) {
    return emptyPushResult(mode, 'completed', '该事件已完整推送', enabled.length);
  }

  // Determine push urgency
  const urgency = getPushUrgency(article);

  // Build Feishu card message（只需构建一次，所有 webhook 共用）
  // 与文章详情页采用同一套双向关联规则；推送场景额外只引用已成功推送的文章。
  const relatedArticles = (await getRelatedArticles(article.id, 3, { onlyPushed: true })) ?? [];
  const card = buildFeishuCard(article, urgency, { relatedArticles });

  let attemptSucceeded = 0;
  for (const config of enabled) {
    assertNotAborted(signal);
    if (!selectedUrls.has(config.url)) continue;
    const ok = await pushToSingleWebhook(eventId, article.id, config, card, signal);
    if (ok) attemptSucceeded++;
  }

  const finalStates = await getPushTargetStates(eventId);
  const allSucceeded = finalStates.length > 0 && finalStates.every((target) => target.latestStatus === 'success');
  const failedCount = selectedUrls.size - attemptSucceeded;
  const skipped = enabled.length - selectedUrls.size;

  if (allSucceeded) {
    // 全部成功：标记已推送
    await db.event.update({
      where: { id: eventId },
      data: { pushedAt: new Date(), nextPushRetryAt: null, pushRetryCount: 0 },
    });
    return { status: 'completed', mode, attempted: selectedUrls.size, succeeded: attemptSucceeded, failed: 0, skipped, message: `已完成 ${selectedUrls.size} 个目标投递` };
  }

  // 部分或全部失败：有限次数自动重试，耗尽后转人工处理。
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
 * 向单个 webhook 发送推送（含 PushLog 写入）；失败/成功都记目标级日志。
 */
async function pushToSingleWebhook(
  eventId: string,
  representativeArticleId: string,
  config: WebhookConfig,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await sendFeishuWebhook(config, card, signal);
  if (result.ok) {
    await db.pushLog.create({
      data: {
        eventId,
        representativeArticleId,
        status: 'success',
        retryCount: result.retryCount,
        webhookUrl: config.url,
        webhookRemark: config.remark,
      },
    });
    return true;
  }

  await db.pushLog.create({
    data: {
      eventId,
      representativeArticleId,
      status: 'failure',
      errorMessage: result.errorMessage ?? 'Push request failed',
      retryCount: result.retryCount,
      webhookUrl: config.url,
      webhookRemark: config.remark,
    },
  });
  return false;
}
