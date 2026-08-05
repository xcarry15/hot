/**
 * 推送策略与统一门禁。
 *
 * pushable where、紧急度和 retry 资格收敛到本模块；只有读取运行时设置的
 * 推送模式和免打扰时段保留为异步门禁，避免组件或 Route Handler 各自复制口径。
 */
import type { PushMode } from '@/contracts/push';
import { parsePushMode } from '@/contracts/push';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import { DEFAULT_QUIET_END, DEFAULT_QUIET_START, isWithinQuietHours } from '@/lib/quiet-hours';

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
export async function isWithinConfiguredQuietHours(now = new Date()): Promise<boolean> {
  const [start, end] = await Promise.all([
    getSetting(SETTING_KEYS.CRAWL_QUIET_START),
    getSetting(SETTING_KEYS.CRAWL_QUIET_END),
  ]);
  return isWithinQuietHours(now, start || DEFAULT_QUIET_START, end || DEFAULT_QUIET_END);
}

export async function shouldPushAtPipelineEnd(options?: { respectQuietHours?: boolean; now?: Date }): Promise<boolean> {
  if ((await readPushSettings()).pushMode !== 'realtime') return false;
  if (options?.respectQuietHours && await isWithinConfiguredQuietHours(options.now)) return false;
  return true;
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
    clusterReviewStatus: 'confirmed' as const,
    representativeArticle: {
      is: {
        score: { gte: settings.minScore },
        relevance: { gte: settings.minRelevance },
        aiStatus: 'done' as const,
        clusterStatus: 'clustered' as const,
        technicalIgnoredAt: null,
        source: { is: { deletedAt: null } },
      },
    },
    OR: [
      { nextPushRetryAt: null },
      { nextPushRetryAt: { lte: new Date() } },
    ],
  };
}
