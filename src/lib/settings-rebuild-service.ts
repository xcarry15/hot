import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { SCORE_WEIGHT_META } from '@/lib/prompts';
import { applyScorePolicy, buildScorePolicySnapshot } from '@/lib/score-policy';
import { recalculateEventsInTransaction } from '@/lib/event-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { rebuildPublicPublicationSnapshotInBatches } from '@/lib/public-publication-service';

export const SETTINGS_REBUILD_KEY = '__runtime_settings_rebuild__';

const SETTINGS_REBUILD_BATCH_SIZE = 100;

export interface SettingsRebuildPlan {
  id: string;
  score: boolean;
  publication: boolean;
}

type ScorePolicyConfig = {
  eventWeight: number;
  contentWeight: number;
  keywordBonus: number;
};

function parsePlan(value: string | null | undefined): SettingsRebuildPlan | null {
  if (!value?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const plan = parsed as Partial<SettingsRebuildPlan>;
    if (typeof plan.id !== 'string' || !plan.id) return null;
    return {
      id: plan.id,
      score: plan.score === true,
      publication: plan.publication === true,
    };
  } catch {
    return null;
  }
}

/** 合并重建原因；新计划使用新 token，旧 worker 不能误清空它。 */
export function mergeSettingsRebuildPlan(
  existingValue: string | null | undefined,
  requested: Pick<SettingsRebuildPlan, 'score' | 'publication'>,
): SettingsRebuildPlan {
  const existing = parsePlan(existingValue);
  return {
    id: randomUUID(),
    score: requested.score || existing?.score === true,
    publication: requested.publication || existing?.publication === true,
  };
}

export function hasSettingsRebuildPlan(value: string | null | undefined): boolean {
  const plan = parsePlan(value);
  return Boolean(plan?.score || plan?.publication);
}

export async function hasPendingSettingsRebuild(): Promise<boolean> {
  const marker = await db.setting.findUnique({
    where: { key: SETTINGS_REBUILD_KEY },
    select: { value: true },
  });
  return hasSettingsRebuildPlan(marker?.value);
}

async function getScorePolicyConfig(): Promise<ScorePolicyConfig> {
  const keys = [
    SETTING_KEYS.AI_WEIGHT_EVENT,
    SETTING_KEYS.AI_WEIGHT_CONTENT,
    SETTING_KEYS.AI_KEYWORD_MATCH_BONUS,
  ];
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const eventWeight = Number(settings.get(SETTING_KEYS.AI_WEIGHT_EVENT) ?? SCORE_WEIGHT_META.event.defaultWeight);
  const contentWeight = Number(settings.get(SETTING_KEYS.AI_WEIGHT_CONTENT) ?? SCORE_WEIGHT_META.content.defaultWeight);
  const keywordBonus = Number(settings.get(SETTING_KEYS.AI_KEYWORD_MATCH_BONUS) ?? 5);
  return {
    eventWeight: Number.isFinite(eventWeight) ? eventWeight : SCORE_WEIGHT_META.event.defaultWeight,
    contentWeight: Number.isFinite(contentWeight) ? contentWeight : SCORE_WEIGHT_META.content.defaultWeight,
    keywordBonus: Number.isFinite(keywordBonus) ? keywordBonus : 5,
  };
}

async function rebuildScorePolicy(config: ScorePolicyConfig): Promise<number> {
  let cursor: string | undefined;
  let recomputed = 0;
  while (true) {
    const articles = await db.article.findMany({
      where: {
        eventScore: { not: null },
        contentScore: { not: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: SETTINGS_REBUILD_BATCH_SIZE,
      select: {
        id: true,
        eventId: true,
        eventScore: true,
        contentScore: true,
        adProbability: true,
        isAd: true,
        keywordMatched: true,
      },
    });
    if (articles.length === 0) break;

    await db.$transaction(async (tx) => {
      const affectedEventIds = new Set<string>();
      for (const article of articles) {
        const result = applyScorePolicy(
          article.eventScore!,
          article.contentScore!,
          article.adProbability ?? (article.isAd ? 100 : 0),
          article.isAd,
          config.eventWeight,
          config.contentWeight,
          article.keywordMatched,
          config.keywordBonus,
        );
        await tx.article.update({
          where: { id: article.id },
          data: {
            score: result.finalScore,
            rawScore: result.rawScore,
            scorePolicyVersion: result.version,
            scorePolicySnapshot: buildScorePolicySnapshot(
              config.eventWeight,
              config.contentWeight,
              config.keywordBonus,
              article.keywordMatched,
            ),
          },
        });
        if (article.eventId) affectedEventIds.add(article.eventId);
      }
      await recalculateEventsInTransaction(tx, [...affectedEventIds]);
    }, { maxWait: 10_000, timeout: 10_000 });

    recomputed += articles.length;
    cursor = articles[articles.length - 1]!.id;
  }
  return recomputed;
}

/**
 * 处理当前设置派生状态。使用 token compare-and-swap 清除标记：重算期间的
 * 新设置会保留新的 marker，随后自动再跑一轮，不会被旧 worker 覆盖。
 */
export async function rebuildPendingSettings(): Promise<{
  ran: boolean;
  recomputed: number;
  publicationRebuilt: number;
  superseded: boolean;
}> {
  const marker = await db.setting.findUnique({
    where: { key: SETTINGS_REBUILD_KEY },
    select: { value: true },
  });
  const rawPlan = marker?.value ?? '';
  const plan = parsePlan(rawPlan);
  if (!plan || (!plan.score && !plan.publication)) {
    return { ran: false, recomputed: 0, publicationRebuilt: 0, superseded: false };
  }

  const scoreConfig = plan.score ? await getScorePolicyConfig() : null;
  const recomputed = scoreConfig ? await rebuildScorePolicy(scoreConfig) : 0;
  const publicationRebuilt = plan.publication
    ? await rebuildPublicPublicationSnapshotInBatches({ contentChanged: plan.score })
    : 0;
  const cleared = await db.setting.updateMany({
    where: { key: SETTINGS_REBUILD_KEY, value: rawPlan },
    data: { value: '' },
  });
  invalidatePublicArticleCache();
  return {
    ran: true,
    recomputed,
    publicationRebuilt,
    superseded: cleared.count === 0,
  };
}
