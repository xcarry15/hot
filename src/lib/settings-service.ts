import { z } from 'zod';
import { db } from '@/lib/db';
import { invalidateAISettingsCache } from '@/lib/ai-client';
import {
  EXPORTABLE_SETTING_KEYS, WRITABLE_SETTING_KEYS, SETTING_DEFINITION_MAP, SENSITIVE_SETTING_KEYS, getSettingDefaults, getExportableSettingDefaults,
} from '@/lib/settings';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { parseWebhookConfigsForServer, serializeWebhookConfigsForServer } from '@/contracts/webhook';
import { decryptWebhookConfigsForRuntime, encryptWebhookConfigsForStorage } from '@/lib/settings-crypto';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { PUBLIC_PUBLICATION_REBUILD_KEYS } from '@/lib/public-publication-service';
import { DEFAULT_PROMPT_SETTINGS, SCORE_WEIGHT_META } from '@/lib/prompts';
import { mergeSettingsRebuildPlan, SETTINGS_REBUILD_KEY } from '@/lib/settings-rebuild-service';

const settingsUpdateSchema = z.record(z.string(), z.string());
const MAX_SETTING_KEYS_PER_REQUEST = 100;
const MAX_SETTING_VALUE_LENGTH = 100_000;
const MAX_SETTINGS_PAYLOAD_LENGTH = 500_000;

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
  for (const row of rows) {
    settings[row.key] = row.key === SETTING_KEYS.FEISHU_WEBHOOK_URL
      ? decryptWebhookConfigsForRuntime(row.value)
      : row.value;
  }
  return { type: 'hot2-settings', version: 1, exportedAt: new Date().toISOString(), settings };
}

export async function revealSensitiveSettings(requestedKeys?: string[]) {
  const keys = requestedKeys?.length
    ? requestedKeys.filter((key) => SENSITIVE_SETTING_KEYS.has(key))
    : Array.from(SENSITIVE_SETTING_KEYS);
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const rowMap = new Map(rows.map((row) => [row.key, row.value]));
  // 敏感配置允许尚未创建数据库行（例如新安装尚未填写 API Key）。
  // 仍按请求键返回空值，客户端才能区分“安全读取成功但为空”和“读取失败”。
  return Object.fromEntries(keys.map((key) => {
    const value = rowMap.get(key) ?? '';
    return [
      key,
      key === SETTING_KEYS.FEISHU_WEBHOOK_URL
        ? (value ? decryptWebhookConfigsForRuntime(value) : '[]')
        : value,
    ];
  }));
}

export async function updateSettings(input: unknown): Promise<
  | { ok: true; success?: boolean; rebuildQueued?: boolean }
  | { ok: false; error: string; details: unknown[] }
> {
  const parsed = settingsUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '无效的请求格式', details: parsed.error.issues };
  const entries = Object.entries(parsed.data);
  const oversizedKey = entries.find(([, value]) => value.length > MAX_SETTING_VALUE_LENGTH)?.[0];
  const payloadLength = entries.reduce((total, [key, value]) => total + key.length + value.length, 0);
  if (entries.length > MAX_SETTING_KEYS_PER_REQUEST) {
    return { ok: false, error: '设置值校验失败', details: [`单次最多更新 ${MAX_SETTING_KEYS_PER_REQUEST} 个配置`] };
  }
  if (oversizedKey) {
    return { ok: false, error: '设置值校验失败', details: [`配置 ${oversizedKey} 内容过长`] };
  }
  if (payloadLength > MAX_SETTINGS_PAYLOAD_LENGTH) {
    return { ok: false, error: '设置值校验失败', details: ['设置内容总长度超过限制'] };
  }
  const normalizedData = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => (
    key === SETTING_KEYS.PUSH_TIME && value.startsWith('cron:')
      ? [key, '08:30']
      : !value.trim() && key in DEFAULT_PROMPT_SETTINGS
        ? [key, DEFAULT_PROMPT_SETTINGS[key as keyof typeof DEFAULT_PROMPT_SETTINGS]]
        : [key, value]
  )));
  const validationErrors: string[] = [];
  for (const [key, value] of Object.entries(normalizedData)) {
    if (!WRITABLE_SETTING_KEYS.includes(key)) { validationErrors.push(`${key}: 不可写(不在允许的配置键清单内)`); continue; }
    const definition = SETTING_DEFINITION_MAP.get(key);
    if (!definition) { validationErrors.push(`${key}: 不可写(未在配置目录中声明)`); continue; }
    const result = definition.schema.safeParse(value);
    if (!result.success) validationErrors.push(`${key}: ${result.error.issues[0].message}`);
    if (key === SETTING_KEYS.FEISHU_WEBHOOK_URL) {
      try {
        parseWebhookConfigsForServer(value);
      } catch (error) {
        validationErrors.push(`${key}: ${error instanceof Error ? error.message : 'Webhook 配置无效'}`);
      }
    }
  }
  if (validationErrors.length > 0) return { ok: false, error: '设置值校验失败', details: validationErrors };

  // GET /api/settings 会把敏感配置脱敏为 ""。完整保存其他设置时，不能把这个
  // 占位空值当成用户清空操作；Webhook 的显式清空由客户端提交 "[]" 表示，真实 URL
  // 在进入事务前统一加密。
  const preserveRedactedSensitiveKeys = new Set(
    Object.entries(parsed.data)
      .filter(([key, value]) => SENSITIVE_SETTING_KEYS.has(key) && value.trim() === '')
      .map(([key]) => key),
  );
  let updates = Object.entries(normalizedData) as [string, string][];
  updates = updates.map(([key, value]) => key === SETTING_KEYS.FEISHU_WEBHOOK_URL
    ? [key, encryptWebhookConfigsForStorage(serializeWebhookConfigsForServer(parseWebhookConfigsForServer(value)))]
    : [key, value]);
  const keepKeys = updates.filter(([key]) => preserveRedactedSensitiveKeys.has(key)).map(([key]) => key);
  if (keepKeys.length > 0) {
    const existing = await db.setting.findMany({ where: { key: { in: keepKeys } } });
    const existingMap = new Map(existing.map((setting) => [setting.key, setting.value]));
    updates = updates.map(([key, value]) => preserveRedactedSensitiveKeys.has(key) && existingMap.has(key)
      ? [key, key === SETTING_KEYS.FEISHU_WEBHOOK_URL
        ? encryptWebhookConfigsForStorage(existingMap.get(key)!)
        : existingMap.get(key)!]
      : [key, value]);
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
  // 只把用户设置及“派生状态待重建”标记放进短事务。评分/公开状态由后台
  // Job 分批处理；这样不会因为一张大 articles 表长期锁住 SQLite。
  const rebuildQueued = scorePolicyChanged || publicationNeedsRebuild;
  await db.$transaction(async (tx) => {
    for (const [key, value] of updates) {
      await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    if (rebuildQueued) {
      const marker = await tx.setting.findUnique({
        where: { key: SETTINGS_REBUILD_KEY },
        select: { value: true },
      });
      const plan = mergeSettingsRebuildPlan(marker?.value, {
        score: scorePolicyChanged,
        publication: publicationNeedsRebuild,
      });
      await tx.setting.upsert({
        where: { key: SETTINGS_REBUILD_KEY },
        update: { value: JSON.stringify(plan) },
        create: { key: SETTINGS_REBUILD_KEY, value: JSON.stringify(plan) },
      });
    }
  }, { maxWait: 10_000, timeout: 10_000 });
  invalidateAISettingsCache();
  invalidatePublicArticleCache();
  return { ok: true, success: true, rebuildQueued };
}
