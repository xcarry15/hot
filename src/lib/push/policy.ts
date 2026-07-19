/**
 * 推送策略（纯策略）。
 *
 * 不读数据库、不依赖全局状态。所有策略行为（pushable where 重用、紧急度、
 * retry 资格）都收敛到本模块的纯函数。
 */
import type { PushMode } from '@/contracts/push';
import { parsePushMode } from '@/contracts/push';
import { getSetting, SETTING_KEYS } from '@/lib/settings';

export const PUSH_RETRY_DELAY_MS = 6 * 60 * 60 * 1000; // 6h
export const PUSH_MAX_RETRIES = 5;

export interface PushSettings {
  pushMode: PushMode;
  minScore: number;
  minRelevance: number;
}

export async function readPushSettings(): Promise<PushSettings> {
  const pushMode = parsePushMode(await getSetting(SETTING_KEYS.PUSH_MODE));
  const minScore = parseInt(await getSetting(SETTING_KEYS.PUSH_MIN_SCORE) || '80', 10);
  const minRelevance = parseInt(await getSetting(SETTING_KEYS.PUSH_MIN_RELEVANCE) || '70', 10);
  return {
    pushMode,
    minScore,
    minRelevance,
  };
}

/** full-pipeline job 跑完后是否需要立即推送：realtime 才推。 */
export async function shouldPushAtPipelineEnd(): Promise<boolean> {
  return (await readPushSettings()).pushMode === 'realtime';
}

/**
 * 可推送事件的统一 where 条件——countPushableArticles 与 pushAllUnpushed 共用,
 * 避免两份复制 where 演化时口径分叉。
 *
 * 契约:只推 AI 真正分析过的文章(aiStatus='done')。'failed' 文章不进推送队列,
 * 守住「推给用户的都经过 AI」;它们仍在 analyzeAllPending 的重试池里下一轮重试。
 */
export function pushableWhere(settings: PushSettings) {
  return {
    pushedAt: null,
    pushRetryCount: { lt: PUSH_MAX_RETRIES },
    status: 'active' as const,
    representativeArticle: {
      is: {
        score: { gte: settings.minScore },
        relevance: { gte: settings.minRelevance },
        aiStatus: 'done' as const,
        clusterStatus: 'clustered' as const,
        technicalIgnoredAt: null,
      },
    },
    OR: [
      { nextPushRetryAt: null },
      { nextPushRetryAt: { lte: new Date() } },
    ],
  };
}
