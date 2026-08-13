import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  AI_RESET_ARTICLE_SELECT,
  resetArticleAiAndEventState,
} from '@/lib/maintenance-service';

const RECOVERY_BATCH_SIZE = 100;

function buildAiRecoveryWhere(forceRetry: boolean, now: Date): Prisma.ArticleWhereInput {
  const inconsistentState: Prisma.ArticleWhereInput = {
    OR: [
      { eventId: { not: null } },
      { clusterStatus: { not: 'pending' } },
    ],
  };

  return {
    fetchStatus: 'fetched',
    technicalIgnoredAt: null,
    ...(forceRetry
      ? {
          OR: [
            { aiStatus: 'failed' },
            { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
            {
              aiStatus: 'pending',
              OR: [
                { nextAiRetryAt: { not: null } },
                { eventId: { not: null } },
                { clusterStatus: { not: 'pending' } },
              ],
            },
          ],
        }
      : {
          AND: [
            inconsistentState,
            {
              OR: [
                { aiStatus: 'failed', nextAiRetryAt: { lte: now } },
                { aiStatus: 'pending', nextAiRetryAt: { lte: now } },
              ],
            },
          ],
        }),
  };
}

/**
 * 把批量 AI 恢复对象收敛到与单篇 regenerate 相同的入口状态。
 *
 * - 人工运行全流程：立即恢复 waiting/failed/技术 skipped，并清除旧 Event 与聚类残留；
 * - 自动恢复：只修复已经到期、但因 Event/聚类残留而无法进入 analyze 查询的异常组合；
 * - 正常 pending 新文章不做无意义重置。
 */
export async function normalizeAiRecoveryBacklog(
  forceRetry: boolean,
  now = new Date(),
): Promise<number> {
  let normalized = 0;
  while (true) {
    const articles = await db.article.findMany({
      where: buildAiRecoveryWhere(forceRetry, now),
      orderBy: { id: 'asc' },
      take: RECOVERY_BATCH_SIZE,
      select: AI_RESET_ARTICLE_SELECT,
    });
    if (articles.length === 0) break;

    await db.$transaction(async (tx) => {
      await resetArticleAiAndEventState(tx, articles);
      if (forceRetry) {
        const articleIds = articles.map((article) => article.id);
        await tx.keywordHit.deleteMany({ where: { articleId: { in: articleIds } } });
        await tx.article.updateMany({
          where: { id: { in: articleIds } },
          data: {
            fetchStatus: 'pending',
            fetchError: null,
            fetchRetryCount: 0,
            nextFetchRetryAt: null,
            keywordMatched: false,
          },
        });
      }
    }, { maxWait: 10_000, timeout: 10_000 });
    normalized += articles.length;
  }
  return normalized;
}
