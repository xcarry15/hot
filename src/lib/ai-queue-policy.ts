import type { Prisma } from '@prisma/client';

export type AiResetAction = 'reset-ai' | 'reset-ai-failed';

/** 人工/自动 AI 恢复共用的候选文章条件。 */
export function buildAiRecoveryWhere(forceRetry: boolean, now: Date): Prisma.ArticleWhereInput {
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

/** AI 重置维护任务的候选文章条件。 */
export function buildAiResetWhere(action: AiResetAction): Prisma.ArticleWhereInput {
  return action === 'reset-ai'
    ? { aiStatus: { not: 'pending' } }
    : {
        OR: [
          { aiStatus: 'failed' },
          { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
        ],
      };
}
