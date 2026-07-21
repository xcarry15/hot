import { z } from 'zod';
import { db } from '@/lib/db';
import { invalidateAISettingsCache } from '@/lib/ai-client';
import {
  EXPORTABLE_SETTING_KEYS, SETTING_DEFINITION_MAP, SENSITIVE_SETTING_KEYS, getSettingDefaults, getExportableSettingDefaults,
} from '@/lib/settings';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { applyScorePolicy, buildScorePolicySnapshot } from '@/lib/score-policy';
import { parseWebhookConfigs, serializeWebhookConfigsForServer } from '@/contracts/webhook';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { PUBLIC_PUBLICATION_REBUILD_KEYS, rebuildPublicPublicationSnapshot } from '@/lib/public-publication-service';
import { DEFAULT_PROMPT_SETTINGS, SCORE_WEIGHT_META } from '@/lib/prompts';
import { recalculateEventById } from '@/lib/event-service';

const settingsUpdateSchema = z.record(z.string(), z.string());

export async function getSettings() {
  const settings = await db.setting.findMany();
  const map = getSettingDefaults({ redactSensitive: true });
  for (const setting of settings) {
    if (!SETTING_DEFINITION_MAP.has(setting.key)) continue;
    map[setting.key] = SENSITIVE_SETTING_KEYS.has(setting.key)
      ? ''
      : setting.key in DEFAULT_PROMPT_SETTINGS && !setting.value.trim()
        ? DEFAULT_PROMPT_SETTINGS[setting.key as keyof typeof DEFAULT_PROMPT_SETTINGS]
        : setting.value;
  }
  return map;
}

export async function exportSettings() {
  const rows = await db.setting.findMany({ where: { key: { in: Array.from(EXPORTABLE_SETTING_KEYS) } } });
  const settings = getExportableSettingDefaults();
  for (const row of rows) settings[row.key] = row.value;
  return { type: 'hot2-settings', version: 1, exportedAt: new Date().toISOString(), settings };
}

export async function revealSensitiveSettings(requestedKeys?: string[]) {
  const keys = requestedKeys?.length
    ? requestedKeys.filter((key) => SENSITIVE_SETTING_KEYS.has(key))
    : Array.from(SENSITIVE_SETTING_KEYS);
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function updateSettings(input: unknown): Promise<
  | { ok: true; success?: boolean; scoreRecomputed?: number; publicationRebuilt?: boolean }
  | { ok: false; error: string; details: unknown[] }
> {
  const parsed = settingsUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '无效的请求格式', details: parsed.error.issues };
  const normalizedData = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => (
    key === SETTING_KEYS.PUSH_TIME && value.startsWith('cron:')
      ? [key, '08:30']
      : !value.trim() && key in DEFAULT_PROMPT_SETTINGS
        ? [key, DEFAULT_PROMPT_SETTINGS[key as keyof typeof DEFAULT_PROMPT_SETTINGS]]
        : [key, value]
  )));
  const validationErrors: string[] = [];
  for (const [key, value] of Object.entries(normalizedData)) {
    if (!EXPORTABLE_SETTING_KEYS.includes(key)) { validationErrors.push(`${key}: 不可写(不在允许的配置键清单内)`); continue; }
    const definition = SETTING_DEFINITION_MAP.get(key);
    if (!definition || !definition.exportable) { validationErrors.push(`${key}: 不可写(未在配置目录中声明)`); continue; }
    const result = definition.schema.safeParse(value);
    if (!result.success) validationErrors.push(`${key}: ${result.error.issues[0].message}`);
  }
  if (validationErrors.length > 0) return { ok: false, error: '设置值校验失败', details: validationErrors };

  let updates = Object.entries(normalizedData) as [string, string][];
  updates = updates.map(([key, value]) => key === SETTING_KEYS.FEISHU_WEBHOOK_URL
    ? [key, serializeWebhookConfigsForServer(parseWebhookConfigs(value))]
    : [key, value]);
  const keepKeys = updates.filter(([key, value]) => SENSITIVE_SETTING_KEYS.has(key) && value === '').map(([key]) => key);
  if (keepKeys.length > 0) {
    const existing = await db.setting.findMany({ where: { key: { in: keepKeys } } });
    const existingMap = new Map(existing.map((setting) => [setting.key, setting.value]));
    updates = updates.map(([key, value]) => SENSITIVE_SETTING_KEYS.has(key) && value === '' && existingMap.has(key)
      ? [key, existingMap.get(key)!] : [key, value]);
  }
  const scoreSettingKeys = [
    SETTING_KEYS.AI_WEIGHT_EVENT,
    SETTING_KEYS.AI_WEIGHT_CONTENT,
    SETTING_KEYS.AI_KEYWORD_MATCH_BONUS,
  ];
  const previousScoreSettings = await db.setting.findMany({
    where: { key: { in: scoreSettingKeys } },
  });
  const previousScoreMap = Object.fromEntries(previousScoreSettings.map(x => [x.key, x.value]));
  const requestedEventWeight = parsed.data[SETTING_KEYS.AI_WEIGHT_EVENT];
  const requestedContentWeight = parsed.data[SETTING_KEYS.AI_WEIGHT_CONTENT];
  const requestedKeywordBonus = parsed.data[SETTING_KEYS.AI_KEYWORD_MATCH_BONUS];
  const effectiveEventWeight = Number(
    requestedEventWeight
      ?? previousScoreMap[SETTING_KEYS.AI_WEIGHT_EVENT]
      ?? SCORE_WEIGHT_META.event.defaultWeight,
  );
  const effectiveContentWeight = Number(
    requestedContentWeight
      ?? previousScoreMap[SETTING_KEYS.AI_WEIGHT_CONTENT]
      ?? SCORE_WEIGHT_META.content.defaultWeight,
  );
  const effectiveKeywordBonus = Number(
    requestedKeywordBonus
      ?? previousScoreMap[SETTING_KEYS.AI_KEYWORD_MATCH_BONUS]
      ?? 5,
  );
  if (effectiveEventWeight + effectiveContentWeight !== 100) {
    return { ok: false, error: '设置值校验失败', details: ['评分权重合计必须为 100'] };
  }
  const scorePolicyChanged = updates.some(([key, value]) => {
    if (!(scoreSettingKeys as readonly string[]).includes(key)) return false;
    const fallback = key === SETTING_KEYS.AI_WEIGHT_EVENT
      ? SCORE_WEIGHT_META.event.defaultWeight
      : key === SETTING_KEYS.AI_WEIGHT_CONTENT
        ? SCORE_WEIGHT_META.content.defaultWeight
        : 5;
    return Number(previousScoreMap[key] ?? fallback) !== Number(value);
  });
  const publicationNeedsRebuild = scorePolicyChanged || updates.some(([key]) => PUBLIC_PUBLICATION_REBUILD_KEYS.has(key));
  const updateMap = Object.fromEntries(updates);
  const nextWeightEvent = Number(updateMap[SETTING_KEYS.AI_WEIGHT_EVENT] ?? effectiveEventWeight);
  const nextWeightContent = Number(updateMap[SETTING_KEYS.AI_WEIGHT_CONTENT] ?? effectiveContentWeight);
  const nextKeywordBonus = Number(updateMap[SETTING_KEYS.AI_KEYWORD_MATCH_BONUS] ?? effectiveKeywordBonus);

  // 设置与历史文章重算在同一事务提交，避免“权重已保存、文章只更新一部分”。
  const scoreRecomputed = scorePolicyChanged ? await db.$transaction(async tx => {
    for (const [key, value] of updates) {
      await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    let recomputed = 0;
    const affectedEventIds = new Set<string>();
    if (scorePolicyChanged) {
      const articles = await tx.article.findMany({
        where: { eventScore: { not: null }, contentScore: { not: null } },
        select: { id: true, eventId: true, eventScore: true, contentScore: true, adProbability: true, isAd: true, keywordMatched: true },
      });
      for (const article of articles) {
        const result = applyScorePolicy(
          article.eventScore!, article.contentScore!, article.adProbability ?? (article.isAd ? 100 : 0),
          article.isAd, nextWeightEvent, nextWeightContent,
          article.keywordMatched, nextKeywordBonus,
        );
        await tx.article.update({
          where: { id: article.id },
          data: {
            score: result.finalScore,
            rawScore: result.rawScore,
            scorePolicyVersion: result.version,
            scorePolicySnapshot: buildScorePolicySnapshot(
              nextWeightEvent,
              nextWeightContent,
              nextKeywordBonus,
              article.keywordMatched,
            ),
          },
        });
        if (article.eventId) affectedEventIds.add(article.eventId);
        recomputed++;
      }
    }
    if (publicationNeedsRebuild) {
      await rebuildPublicPublicationSnapshot(tx, { contentChanged: scorePolicyChanged });
    }
    return { recomputed, eventIds: [...affectedEventIds] };
  }, { maxWait: 10_000, timeout: 120_000 }) : await db.$transaction(async tx => {
    for (const [key, value] of updates) await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    if (publicationNeedsRebuild) await rebuildPublicPublicationSnapshot(tx, { contentChanged: false });
    return { recomputed: 0, eventIds: [] as string[] };
  }, { maxWait: 10_000, timeout: 120_000 });
  for (const eventId of scoreRecomputed.eventIds) await recalculateEventById(eventId);
  invalidateAISettingsCache();
  invalidatePublicArticleCache();
  return { ok: true, success: true, scoreRecomputed: scoreRecomputed.recomputed, publicationRebuilt: publicationNeedsRebuild };
}
