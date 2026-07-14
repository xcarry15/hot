/**
 * 文章级 push delivery。
 *
 * 职责：
 *   - 同一 articleId 同一时刻只允许一次推送（inFlightPushes 锁，按 plan 归本模块管辖）
 *   - 在 PushLog 中按目标级记录成功/失败事实；部分成功重试只补未成功 URL
 *   - 推送结束后根据全部目标结果更新 article.pushedAt / nextRetryAt
 *
 * 不依赖 Next.js / Route，调用方为 pushAllUnpushed 与 /api/push。
 */
import { db } from '@/lib/db';
import { assertNotAborted } from '@/lib/worker-stop';
import { splitBrands } from '@/lib/shared/article-codecs';
import { getWebhookConfigs, type WebhookConfig } from '@/lib/settings';
import { PUSH_RETRY_DELAY_MS, readPushSettings } from '@/lib/push/policy';
import { getPushUrgency, buildFeishuCard } from '@/lib/push/feishu-card';
import { sendFeishuWebhook } from '@/lib/push/feishu-transport';

/** 同 articleId 并发去重；同一时刻只允许一次推送尝试。 */
const inFlightPushes = new Map<string, Promise<PushArticleResult>>();

/** 推送结果：区分全部成功/部分成功/全部失败/无 Webhook */
export interface PushArticleResult {
  status: 'completed' | 'partial' | 'failed' | 'no_webhooks';
  succeeded: number;
  failed: number;
  message: string;
}

/** Push a single article to all enabled Feishu webhooks.
 *  Each webhook gets its own PushLog entry (with webhookUrl + webhookRemark).
 *  @returns PushArticleResult with detailed status
 */
export function pushArticleToFeishu(
  articleId: string,
  force = false,
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  const existing = inFlightPushes.get(articleId);
  if (existing) return existing;

  const task = pushArticleToFeishuInternal(articleId, force, signal).finally(() => {
    if (inFlightPushes.get(articleId) === task) inFlightPushes.delete(articleId);
  });
  inFlightPushes.set(articleId, task);
  return task;
}

/** 暴露给其他模块/测试读取当前 in-flight 状态。 */
export function getInFlightPushes(): ReadonlyMap<string, Promise<PushArticleResult>> {
  return inFlightPushes;
}

async function pushArticleToFeishuInternal(
  articleId: string,
  force = false,
  signal?: AbortSignal,
): Promise<PushArticleResult> {
  assertNotAborted(signal);
  const article = await db.article.findUnique({
    where: { id: articleId },
    include: { source: { select: { name: true } } },
  });
  if (!article) return { status: 'failed', succeeded: 0, failed: 0, message: '文章不存在' };

  // Already pushed (skip unless force)
  if (article.pushedAt && !force) return { status: 'completed', succeeded: 0, failed: 0, message: '已推送过' };
  // nextRetryAt 未到（最近失败过）— 跳过避免重投重复卡片
  if (article.nextRetryAt && article.nextRetryAt > new Date() && !force) {
    return { status: 'failed', succeeded: 0, failed: 0, message: `推送重试等待中，可重试时间: ${article.nextRetryAt.toISOString()}` };
  }

  if (!force) {
    const settings = await readPushSettings();
    if (settings.pushMode === 'off') {
      return { status: 'failed', succeeded: 0, failed: 0, message: '当前推送模式已关闭' };
    }
    if (article.aiStatus !== 'done') {
      return { status: 'failed', succeeded: 0, failed: 0, message: '文章尚未完成 AI 分析，不能普通推送' };
    }
    if (article.score < settings.minScore || article.relevance < settings.minRelevance) {
      return { status: 'failed', succeeded: 0, failed: 0, message: '文章未达到推送阈值，请使用“强制推送”' };
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
    await db.pushLog.create({
      data: {
        articleId,
        status: 'failure',
        errorMessage: '没有配置启用的 Feishu Webhook URL',
      },
    });
    return { status: 'no_webhooks', succeeded: 0, failed: 0, message: '没有配置启用的 Feishu Webhook URL' };
  }

  // Determine push urgency
  const urgency = getPushUrgency(article);

  // Build Feishu card message（只需构建一次，所有 webhook 共用）
  const relatedArticles = await fetchRelatedByBrand(article);
  const card = buildFeishuCard(article, urgency, { relatedArticles });

  // A successful destination is durable in PushLog. On a partial retry, only
  // send to destinations that have never succeeded for this article.
  const previousSuccesses = force
    ? []
    : await db.pushLog.findMany({
        where: {
          articleId,
          status: 'success',
          webhookUrl: { in: enabled.map((c) => c.url) },
        },
        select: { webhookUrl: true },
      });
  const succeededUrls = new Set(previousSuccesses.map((row) => row.webhookUrl));

  for (const config of enabled) {
    assertNotAborted(signal);
    if (!force && succeededUrls.has(config.url)) continue;
    const ok = await pushToSingleWebhook(articleId, config, card, signal);
    if (ok) succeededUrls.add(config.url);
  }

  const allSucceeded = enabled.every((config) => succeededUrls.has(config.url));
  const succeeded = succeededUrls.size;
  const failedCount = enabled.length - succeeded;

  if (allSucceeded) {
    // 全部成功：标记已推送
    await db.article.update({
      where: { id: articleId },
      data: { pushedAt: new Date(), nextRetryAt: null },
    });
    return { status: 'completed', succeeded, failed: 0, message: `已推送到 ${succeeded} 个 Webhook` };
  }

  // 部分或全部失败：设置重试延迟
  await db.article.update({
    where: { id: articleId },
    data: { nextRetryAt: new Date(Date.now() + PUSH_RETRY_DELAY_MS) },
  });

  if (succeeded > 0) {
    return { status: 'partial', succeeded, failed: failedCount, message: `${succeeded} 成功, ${failedCount} 失败` };
  }
  return { status: 'failed', succeeded: 0, failed: failedCount, message: `全部 ${failedCount} 个 Webhook 推送失败` };
}

/**
 * 向单个 webhook 发送推送（含 PushLog 写入）；失败/成功都记目标级日志。
 */
async function pushToSingleWebhook(
  articleId: string,
  config: WebhookConfig,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await sendFeishuWebhook(config, card, signal);
  if (result.ok) {
    await db.pushLog.create({
      data: {
        articleId,
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
      articleId,
      status: 'failure',
      errorMessage: result.errorMessage ?? 'Push request failed',
      retryCount: result.retryCount,
      webhookUrl: config.url,
      webhookRemark: config.remark,
    },
  });
  return false;
}

/**
 * 查询同品牌近 30 天内已推送过的其它文章(最多 3 条),用于卡片末尾的"趋势联动"块。
 * - 只取第一个品牌（article.brand 形如 "海底捞|瑞幸"）,避免多品牌信息过载
 * - pushedAt not null 是推送契约的硬约束(只引用"已推送过"的文章,避免指向未推送低分文章)
 * - aiStatus='done' 与详情页 related-by-brand 对齐,口径一致
 * - 时间窗口优先 publishedAt,回退 createdAt(与 detail route / articles 列表排序约定一致)
 * - 按 score desc 排序,重要的排前面
 * - take: 3 控制卡片高度
 */
async function fetchRelatedByBrand(article: {
  id: string;
  brand: string;
}): Promise<Array<{ title: string; score: number; createdAt: Date }>> {
  const firstBrand = splitBrands(article.brand)[0];
  if (!firstBrand) return [];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return db.article.findMany({
    where: {
      brand: { contains: firstBrand },
      pushedAt: { not: null },
      id: { not: article.id },
      aiStatus: 'done',
      OR: [
        { publishedAt: { gte: thirtyDaysAgo } },
        { publishedAt: null, createdAt: { gte: thirtyDaysAgo } },
      ],
    },
    select: { title: true, score: true, createdAt: true },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: 3,
  });
}
