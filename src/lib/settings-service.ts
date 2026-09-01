import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { invalidateAISettingsCache } from '@/lib/ai-client';
import {
  AI_PROVIDER_API_KEY_KEYS, EXPORTABLE_SETTING_KEYS, WRITABLE_SETTING_KEYS, SETTING_DEFINITION_MAP, SENSITIVE_SETTING_KEYS, getSettingDefaults, getExportableSettingDefaults,
} from '@/lib/settings';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { isOpenCodeFreeModel, isOpenRouterFreeModel, providerSettingKey } from '@/contracts/ai-provider';
import { parseWebhookConfigsForServer, serializeWebhookConfigsForServer } from '@/contracts/webhook';
import {
  decryptSensitiveSetting,
  decryptWebhookConfigsForRuntime,
  encryptSensitiveSetting,
  encryptWebhookConfigsForStorage,
} from '@/lib/settings-crypto';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { invalidateGlobalProxyCache } from '@/lib/proxy-config';
import { PUBLIC_PUBLICATION_REBUILD_KEYS } from '@/lib/public-publication-service';
import { DEFAULT_PROMPT_SETTINGS, SCORE_WEIGHT_META } from '@/lib/prompts';
import { mergeSettingsRebuildPlan, SETTINGS_REBUILD_KEY } from '@/lib/settings-rebuild-service';

const settingsUpdateSchema = z.record(z.string(), z.string());
const MAX_SETTING_KEYS_PER_REQUEST = WRITABLE_SETTING_KEYS.length;
const MAX_SETTING_VALUE_LENGTH = 100_000;
const MAX_SETTINGS_PAYLOAD_LENGTH = 500_000;

export type SettingsUpdateResult =
  | { ok: true; success?: boolean; rebuildQueued?: boolean }
  | { ok: false; error: string; details: unknown[] };

interface SettingsUpdateOptions {
  preserveRedactedSensitive?: boolean;
}

interface ValidatedSettingsInput {
  normalizedData: Record<string, string>;
  preserveRedactedSensitiveKeys: Set<string>;
}

type SettingsValidationResult =
  | { ok: true; data: ValidatedSettingsInput }
  | { ok: false; error: string; details: unknown[] };

function validateSettingsInput(input: unknown, options: SettingsUpdateOptions = {}): SettingsValidationResult {
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
    if (key === providerSettingKey('opencode', 'model') && value.trim() && !isOpenCodeFreeModel(value)) {
      validationErrors.push(`${key}: OpenCode 仅允许免费模型`);
    }
    if (key === providerSettingKey('openrouter', 'model') && value.trim() && !isOpenRouterFreeModel(value)) {
      validationErrors.push(`${key}: OpenRouter 仅允许免费模型`);
    }
    if (key === SETTING_KEYS.FEISHU_WEBHOOK_URL) {
      try {
        parseWebhookConfigsForServer(value);
      } catch (error) {
        validationErrors.push(`${key}: ${error instanceof Error ? error.message : 'Webhook 配置无效'}`);
      }
    }
  }
  if (validationErrors.length > 0) return { ok: false, error: '设置值校验失败', details: validationErrors };

  const preserveRedactedSensitiveKeys = options.preserveRedactedSensitive === false
    ? new Set<string>()
    : new Set(
        Object.entries(parsed.data)
          // 代理页完成 reveal 后提交空值就是明确关闭代理；未完成 reveal 时
          // 前端会直接移除该 key，因此其它敏感配置仍维持“空值=脱敏占位”的保护。
          .filter(([key, value]) => SENSITIVE_SETTING_KEYS.has(key)
            && key !== SETTING_KEYS.OUTBOUND_PROXY_URL
            && value.trim() === '')
          .map(([key]) => key),
      );
  return { ok: true, data: { normalizedData, preserveRedactedSensitiveKeys } };
}

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

export async function exportSettingsValues(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany({ where: { key: { in: Array.from(EXPORTABLE_SETTING_KEYS) } } });
  const settings = getExportableSettingDefaults();
  for (const row of rows) {
    settings[row.key] = row.key === SETTING_KEYS.FEISHU_WEBHOOK_URL
      ? decryptWebhookConfigsForRuntime(row.value)
      : row.key === SETTING_KEYS.OUTBOUND_PROXY_URL || AI_PROVIDER_API_KEY_KEYS.has(row.key)
        ? decryptSensitiveSetting(row.value)
        : row.value;
  }
  return settings;
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
        : key === SETTING_KEYS.OUTBOUND_PROXY_URL || AI_PROVIDER_API_KEY_KEYS.has(key)
          ? (value ? decryptSensitiveSetting(value) : '')
        : value,
    ];
  }));
}

export async function updateSettingsInTransaction(
  tx: Prisma.TransactionClient,
  input: unknown,
  options: SettingsUpdateOptions = {},
): Promise<SettingsUpdateResult> {
  const validation = validateSettingsInput(input, options);
  if (!validation.ok) return validation;
  const { normalizedData, preserveRedactedSensitiveKeys } = validation.data;

  // GET /api/settings 会把敏感配置脱敏为 ""。完整保存其他设置时，不能把这个
  // 占位空值当成用户清空操作；Webhook 的显式清空由客户端提交 "[]" 表示，真实 URL
  // 在进入事务前统一加密。
  let updates = Object.entries(normalizedData) as [string, string][];
  updates = updates.map(([key, value]) => key === SETTING_KEYS.FEISHU_WEBHOOK_URL
    ? [key, encryptWebhookConfigsForStorage(serializeWebhookConfigsForServer(parseWebhookConfigsForServer(value)))]
    : key === SETTING_KEYS.OUTBOUND_PROXY_URL || AI_PROVIDER_API_KEY_KEYS.has(key)
      ? [key, encryptSensitiveSetting(value)]
    : [key, value]);
  const keepKeys = updates.filter(([key]) => preserveRedactedSensitiveKeys.has(key)).map(([key]) => key);
  if (keepKeys.length > 0) {
    const existing = await tx.setting.findMany({ where: { key: { in: keepKeys } } });
    const existingMap = new Map(existing.map((setting) => [setting.key, setting.value]));
    updates = updates.map(([key, value]) => preserveRedactedSensitiveKeys.has(key) && existingMap.has(key)
      ? [key, existingMap.get(key)!]
      : [key, value]);
  }
  const scoreSettingKeys = [
    SETTING_KEYS.AI_WEIGHT_EVENT,
    SETTING_KEYS.AI_WEIGHT_CONTENT,
    SETTING_KEYS.AI_KEYWORD_MATCH_BONUS,
  ];
  const previousScoreSettings = await tx.setting.findMany({
    where: { key: { in: scoreSettingKeys } },
  });
  const previousScoreMap = Object.fromEntries(previousScoreSettings.map(x => [x.key, x.value]));
  const requestedEventWeight = normalizedData[SETTING_KEYS.AI_WEIGHT_EVENT];
  const requestedContentWeight = normalizedData[SETTING_KEYS.AI_WEIGHT_CONTENT];
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
  return { ok: true, success: true, rebuildQueued };
}

export function invalidateSettingsRuntimeCaches(): void {
  invalidateAISettingsCache();
  invalidatePublicArticleCache();
  invalidateGlobalProxyCache();
}

export async function updateSettings(input: unknown): Promise<SettingsUpdateResult> {
  const validation = validateSettingsInput(input);
  if (!validation.ok) return validation;
  const result = await db.$transaction(
    (tx) => updateSettingsInTransaction(tx, input),
    { maxWait: 10_000, timeout: 10_000 },
  );
  if (result.ok) invalidateSettingsRuntimeCaches();
  return result;
}
