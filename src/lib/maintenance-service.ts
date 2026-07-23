/**
 * Maintenance 应用服务。
 *
 * 负责把清理（Cleanup）相关用例从 Route 中抽离：
 *   - getCleanupStats：统计 articles / logs / discarded / jobs / db 文件大小
 *   - executeMaintenanceAction：根据 action 调度具体写入用例
 *
 * 设计约束：
 *   - 不依赖 Next.js Request / Response；
 *   - 不修改 action 名、删除范围、事务顺序、调度暂停/恢复语义；
 *   - 事务与持久化顺序与原 Route 完全一致。
 *   - 不建立通用 Repository。
 */
import { SETTING_KEYS } from '@/lib/settings';
import { db } from '@/lib/db';
import { abortCurrentJob } from '@/lib/worker-stop';
import { getDbFileSize, runVacuum } from '@/lib/maintenance/sqlite';
import { deleteArticlesByIds } from '@/lib/article-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { rebuildPublicPublicationSnapshot } from '@/lib/public-publication-service';
import { buildAiResetDataForArticle } from '@/lib/article-ai-reset';
import { recalculateEventsInTransaction } from '@/lib/event-service';
import type { Prisma } from '@prisma/client';

type MaintenanceTransaction = Prisma.TransactionClient;
type AiResetArticle = Prisma.ArticleGetPayload<object>;

// ── 只读：统计 ──────────────────────────────────────────────────

export interface CleanupStats {
  articlesTotal: number;
  articlesLowQuality: number;
  articlesPushed: number;
  articlesPending: number;
  dedupLogs: number;
  fetchLogs: number;
  pushLogs: number;
  discardedTotal: number;
  jobsTotal: number;
  dbSizeBytes: number;
}

export async function getCleanupStats(): Promise<CleanupStats> {
  const [
    articlesTotal,
    articlesLowQuality,
    articlesPushed,
    articlesPending,
    dedupLogs,
    fetchLogs,
    pushLogs,
    discardedTotal,
    jobsTotal,
  ] = await Promise.all([
    db.article.count(),
    db.article.count({
      where: {
        score: { lt: 40 },
        aiStatus: 'skipped',
        skipReason: { startsWith: '内容不足' },
      },
    }),
    db.event.count({ where: { pushedAt: { not: null } } }),
    db.article.count({ where: { aiStatus: { in: ['pending', 'failed'] } } }),
    db.event.count({ where: { articleCount: { gt: 1 } } }),
    db.fetchLog.count(),
    db.pushLog.count(),
    db.discardedItem.count(),
    db.job.count(),
  ]);

  return {
    articlesTotal,
    articlesLowQuality,
    articlesPushed,
    articlesPending,
    dedupLogs,
    fetchLogs,
    pushLogs,
    discardedTotal,
    jobsTotal,
    dbSizeBytes: getDbFileSize(),
  };
}

// ── 自动采集临时开关（pause → tx → restore）──────────────────────

interface AutoCrawlGuard {
  prevWasEnabled: boolean;
}

/**
 * 进入事务前临时关闭自动采集，并重置采集时间戳为当前；
 * 在事务提交后再按 `prevWasEnabled` 恢复。
 *
 * 这是 purge-all / all-articles 两个用例共用的"事务级时间窗口"逻辑，
 * 不对外暴露为 action；调用方必须在事务结束后调用 `restoreAutoCrawl`。
 */
async function pauseAutoCrawlForWindow(): Promise<AutoCrawlGuard> {
  const AUTO_CRAWL_KEY = SETTING_KEYS.AUTO_CRAWL_ENABLED;
  const prevAutoCrawl = await db.setting.findUnique({ where: { key: AUTO_CRAWL_KEY } });
  // 不存在视为关闭，与新安装的 scheduler 默认行为一致。
  const prevWasEnabled = prevAutoCrawl?.value === 'true';

  // 事务内由调用方通过 ops 数组写入 pause 与时间戳；
  // 这里只做读，不发起事务。
  void AUTO_CRAWL_KEY;
  return { prevWasEnabled };
}

async function restoreAutoCrawl(prevWasEnabled: boolean): Promise<void> {
  const AUTO_CRAWL_KEY = SETTING_KEYS.AUTO_CRAWL_ENABLED;
  await db.setting.upsert({
    where: { key: AUTO_CRAWL_KEY },
    update: { value: prevWasEnabled ? 'true' : 'false' },
    create: { key: AUTO_CRAWL_KEY, value: prevWasEnabled ? 'true' : 'false' },
  });
}

function pauseAndResetOps() {
  // 历史顺序：AUTO_CRAWL → LAST_CRAWL_AT → Source 重置
  return [
    db.setting.upsert({
      where: { key: SETTING_KEYS.AUTO_CRAWL_ENABLED },
      update: { value: 'false' },
      create: { key: SETTING_KEYS.AUTO_CRAWL_ENABLED, value: 'false' },
    }),
    db.setting.upsert({
      where: { key: SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT },
      update: { value: String(Date.now()) },
      create: { key: SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT, value: String(Date.now()) },
    }),
    db.source.updateMany({
      where: { deletedAt: null },
      data: {
        lastFetchedAt: null,
        consecutiveFailures: 0,
        status: 'normal',
        circuitBreakerUntil: null,
      },
    }),
  ] as const;
}

// ── 重置 AI 状态 ────────────────────────────────────────────────

async function resetArticleAiAndEventState(
  tx: MaintenanceTransaction,
  articles: AiResetArticle[],
): Promise<void> {
  const articleIds = articles.map((article) => article.id);
  if (articleIds.length === 0) return;

  // 重新分析会生成全新的 Event 归属。先解除旧归属和聚类状态，避免
  // analyzeAllPending 因 eventId 非空永远跳过这些文章。
  await tx.eventClusterAudit.deleteMany({ where: { articleId: { in: articleIds } } });
  for (const article of articles) {
    await tx.article.update({
      where: { id: article.id },
      data: {
        ...buildAiResetDataForArticle(article),
        event: { disconnect: true },
        clusterStatus: 'pending',
        clusteredAt: null,
        clusterError: null,
        clusterRetryCount: 0,
        nextClusterRetryAt: null,
      } satisfies Prisma.ArticleUpdateInput,
    });
  }
  // 旧 Event 可能含有未重置成员；重算会保留这些成员，并把空 Event 收口为 merged。
  const eventIds = [...new Set(articles.map((article) => article.eventId).filter((id): id is string => Boolean(id)))];
  await recalculateEventsInTransaction(tx, eventIds);
}

export async function resetAllAi(): Promise<{ reset: number }> {
  let reset = 0;
  await db.$transaction(async tx => {
    const articles = await tx.article.findMany({ where: { aiStatus: { not: 'pending' } } });
    await resetArticleAiAndEventState(tx, articles);
    reset = articles.length;
    if (reset > 0) await rebuildPublicPublicationSnapshot(tx);
  });
  if (reset > 0) invalidatePublicArticleCache();
  return { reset };
}

export async function resetFailedAi(): Promise<{ reset: number }> {
  let reset = 0;
  await db.$transaction(async tx => {
    const articles = await tx.article.findMany({
      where: {
        OR: [
          { aiStatus: 'failed' },
          { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
        ],
      },
    });
    await resetArticleAiAndEventState(tx, articles);
    reset = articles.length;
    if (reset > 0) await rebuildPublicPublicationSnapshot(tx);
  });
  if (reset > 0) invalidatePublicArticleCache();
  return { reset };
}

// ── 清空日志类 ─────────────────────────────────────────────────

export async function clearDedupLogs(): Promise<{ deleted: number }> {
  const result = await db.discardedItem.deleteMany({ where: { reason: { startsWith: 'dedup:' } } });
  return { deleted: result.count };
}

export async function clearFetchLogs(): Promise<{ deleted: number }> {
  const result = await db.fetchLog.deleteMany();
  return { deleted: result.count };
}

export async function deleteLowQualityArticles() {
  const lowQuality = await db.article.findMany({
    // “无具体事件”和“多事件聚合稿”是正常分类结果，不是低质量技术垃圾。
    // AI 技术失败也应进入恢复队列，不应被“低质量清理”直接删除。
    where: {
      score: { lt: 40 },
      aiStatus: 'skipped',
      skipReason: { startsWith: '内容不足' },
    },
    select: { id: true },
  });
  return deleteArticlesByIds(lowQuality.map((a) => a.id));
}

export async function deletePushedArticles() {
  const pushed = await db.article.findMany({
    where: { event: { is: { pushedAt: { not: null } } } },
    select: { id: true },
  });
  return deleteArticlesByIds(pushed.map((a) => a.id));
}

// ── all-articles：删除全部文章 + 暂停 scheduler ──────────────────

export async function deleteAllArticles() {
  // Guard: temporarily disable auto-crawl so scheduler doesn't immediately re-fill deleted articles
  const { prevWasEnabled } = await pauseAutoCrawlForWindow();
  invalidatePublicArticleCache();
  try {
    const [pushResult, , , articleResult] = await db.$transaction([
      db.pushLog.deleteMany(),
      db.pushDelivery.deleteMany(),
      db.eventClusterAudit.deleteMany(),
      db.article.deleteMany(),
      db.event.deleteMany(),
      ...pauseAndResetOps(),
    ]);
    return { deleted: articleResult.count, pushLogsDeleted: pushResult.count };
  } finally {
    await restoreAutoCrawl(prevWasEnabled);
    invalidatePublicArticleCache();
  }
}

// ── purge-all：清空所有业务数据 + 暂停 scheduler + 中止当前 Job ──

export interface PurgeAllDeleted {
  articles: number;
  events: number;
  eventClusterAudits: number;
  pushLogs: number;
  discarded: number;
  discardedRetryAudits: number;
  fetchLogs: number;
  jobs: number;
}

export async function purgeAllData(): Promise<{ deleted: PurgeAllDeleted }> {
  // 清空期间临时关闭自动采集；先 abort 当前 worker 避免并行写入；
  // $transaction 保证原子性。
  abortCurrentJob();
  const { prevWasEnabled } = await pauseAutoCrawlForWindow();
  invalidatePublicArticleCache();
  try {
  const [pushResult, , eventAuditResult, articleResult, eventResult, discardedResult, discardedRetryAuditResult, fetchResult, jobResult] =
      await db.$transaction([
        db.pushLog.deleteMany(),
        db.pushDelivery.deleteMany(),
        db.eventClusterAudit.deleteMany(),
        db.article.deleteMany(),
        db.event.deleteMany(),
        db.discardedItem.deleteMany(),
        db.discardedRetryAudit.deleteMany(),
        db.fetchLog.deleteMany(),
        db.job.deleteMany(),
        ...pauseAndResetOps(),
      ]);
    return {
      deleted: {
        articles: articleResult.count,
        events: eventResult.count,
        eventClusterAudits: eventAuditResult.count,
        pushLogs: pushResult.count,
        discarded: discardedResult.count,
        discardedRetryAudits: discardedRetryAuditResult.count,
        fetchLogs: fetchResult.count,
        jobs: jobResult.count,
      },
    };
  } finally {
    await restoreAutoCrawl(prevWasEnabled);
    invalidatePublicArticleCache();
  }
}

// ── 调度入口 ───────────────────────────────────────────────────

export type MaintenanceActionResult =
  | { deleted: number }
  | { deleted: number; pushLogsDeleted: number }
  | { deleted: PurgeAllDeleted }
  | { reset: number }
  | { vacuumed: true; sizeBefore: number; sizeAfter: number; saved: number };

export type MaintenanceAction =
  | 'purge-all'
  | 'all-articles'
  | 'low-quality'
  | 'pushed-articles'
  | 'dedup-logs'
  | 'fetch-logs'
  | 'reset-ai'
  | 'reset-ai-failed'
  | 'vacuum';

/** 调度入口：原 Route 的 switch 收敛到此处 */
export async function executeMaintenanceAction(
  action: MaintenanceAction,
): Promise<MaintenanceActionResult> {
  switch (action) {
    case 'purge-all':
      return purgeAllData();
    case 'all-articles':
      return deleteAllArticles();
    case 'low-quality':
      return deleteLowQualityArticles();
    case 'pushed-articles':
      return deletePushedArticles();
    case 'dedup-logs':
      return clearDedupLogs();
    case 'fetch-logs':
      return clearFetchLogs();
    case 'reset-ai':
      return resetAllAi();
    case 'reset-ai-failed':
      return resetFailedAi();
    case 'vacuum':
      return runVacuum();
  }
}

// 显式保留 getDbFileSize 的服务端别名，方便快速回滚 / 兼容旧测试
export { getDbFileSize };
