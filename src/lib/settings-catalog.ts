/**
 * Setting 配置描述表（纯模块，可被服务端和客户端共同引用）。
 *
 * 新增配置只需在此声明 key、默认值、校验、敏感性和导出策略；
 * API 白名单、脱敏清单、导出清单和前端默认值均从这里派生。
 * 本文件禁止引入 db 或其他 server-only 依赖。
 */

import { z } from 'zod';
import { AI_PROVIDERS, providerSettingKey, type AIProviderId } from '@/contracts/ai-provider';
import { PUSH_MODES } from '@/contracts/push';
import {
  DEFAULT_BLOCK_AD,
  DEFAULT_BLOCK_BRAND,
  DEFAULT_BLOCK_CATEGORY,
  DEFAULT_BLOCK_CONTENT_SCORE,
  DEFAULT_BLOCK_EVENT_SCORE,
  DEFAULT_BLOCK_EVENT_IDENTITY,
  DEFAULT_BLOCK_KEY_POINTS,
  DEFAULT_BLOCK_RELEVANCE,
  DEFAULT_BLOCK_SUMMARY,
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_BLOCK_META,
  PROMPT_BLOCK_ORDER,
  SCORE_WEIGHT_META,
} from './prompts';

export const SETTING_KEYS = {
  FEISHU_WEBHOOK_URL: 'feishu_webhook_url',
  PUSH_MODE: 'push_mode',
  PUSH_MIN_SCORE: 'push_min_score',
  PUSH_MIN_RELEVANCE: 'push_min_relevance',
  PUSH_TIME: 'push_time',
  PUBLIC_MIN_SCORE: 'public_min_score',
  PUBLIC_MIN_RELEVANCE: 'public_min_relevance',
  PUBLIC_HIDE_ADS: 'public_hide_ads',
  PUBLIC_IMPORTANT_RULE: 'public_important_rule',
  PUBLIC_GENERAL_RULE: 'public_general_rule',
  PUBLIC_IRRELEVANT_RULE: 'public_irrelevant_rule',
  PUBLIC_PIN_HOURS: 'public_pin_hours',

  AUTO_CRAWL_ENABLED: 'auto_crawl_enabled',
  CRAWL_INTERVAL_MIN: 'crawl_interval_min',
  SCHEDULER_LAST_CRAWL_AT: 'scheduler_last_crawl_at',
  SCHEDULER_LAST_PUSH_DATE: 'scheduler_last_push_date',

  AI_PROVIDER: 'ai_provider',
  AI_TEMPERATURE: 'ai_temperature',
  AI_MAX_TOKENS: 'ai_max_tokens',
  AI_SYSTEM_PROMPT: 'ai_system_prompt',
  AI_STEP2_CONTENT_MAX_CHARS: 'ai_step2_content_max_chars',

  AI_BLOCK_AD: 'ai_block_ad',
  AI_BLOCK_EVENT_SCORE: 'ai_block_event_score',
  AI_BLOCK_CATEGORY: 'ai_block_category',
  AI_BLOCK_RELEVANCE: 'ai_block_relevance',
  AI_BLOCK_CONTENT_SCORE: 'ai_block_content_score',
  AI_BLOCK_KEY_POINTS: 'ai_block_key_points',
  AI_BLOCK_SUMMARY: 'ai_block_summary',
  AI_BLOCK_EVENT_IDENTITY: 'ai_block_event_identity',
  AI_BLOCK_BRAND: 'ai_block_brand',

  AI_WEIGHT_EVENT: 'ai_weight_event',
  AI_WEIGHT_CONTENT: 'ai_weight_content',
  AI_KEYWORD_MATCH_BONUS: 'ai_keyword_match_bonus',
  AI_CONCURRENCY: 'ai_concurrency',

} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface SettingDefinition {
  key: string;
  defaultValue: string;
  /** UI 用空值表示“使用默认提示词”，运行时默认值仍由 defaultValue 提供。 */
  uiDefaultValue?: string;
  schema: z.ZodType;
  sensitive: boolean;
  exportable: boolean;
  frontend: boolean;
  seed: boolean;
}

const text = z.string();
const intRange = (min: number, max: number, label: string) =>
  z
    .string()
    .regex(/^\d+$/, `${label}需为数字`)
    .refine((value) => Number(value) >= min && Number(value) <= max, `${label}需在 ${min}-${max} 之间`);

const decimalRange = (min: number, max: number, label: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, `${label}需为数字`)
    .refine((value) => Number(value) >= min && Number(value) <= max, `${label}需在 ${min}-${max} 之间`);

const pushTimeSchema = z.string().refine((value) => {
  const trimmed = value.trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trimmed);
}, '推送时间需为 HH:mm');

const prompt = (key: string, defaultValue: string): SettingDefinition => ({
  key,
  defaultValue,
  uiDefaultValue: '',
  schema: text,
  sensitive: false,
  exportable: true,
  frontend: true,
  seed: false,
});

const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as [AIProviderId, ...AIProviderId[]];

const providerSettingDefinitions: SettingDefinition[] = Object.values(AI_PROVIDERS).flatMap((provider) => [
  { key: providerSettingKey(provider.id, 'api_key'), defaultValue: '', schema: text, sensitive: true, exportable: false, frontend: false, seed: false },
  { key: providerSettingKey(provider.id, 'base_url'), defaultValue: provider.baseUrl, schema: text, sensitive: false, exportable: true, frontend: false, seed: false },
  { key: providerSettingKey(provider.id, 'model'), defaultValue: provider.defaultModel, schema: text, sensitive: false, exportable: true, frontend: false, seed: false },
]);

const definitions: SettingDefinition[] = [
  {
    key: SETTING_KEYS.FEISHU_WEBHOOK_URL,
    defaultValue: '[]',
    schema: text,
    sensitive: true,
    exportable: false,
    frontend: true,
    seed: true,
  },
  { key: SETTING_KEYS.PUSH_MODE, defaultValue: 'realtime', schema: z.enum(PUSH_MODES), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUSH_MIN_SCORE, defaultValue: '80', schema: intRange(0, 100, '最低推送分数'), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUSH_MIN_RELEVANCE, defaultValue: '70', schema: intRange(0, 100, '最低相关度'), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUSH_TIME, defaultValue: '08:30', schema: pushTimeSchema, sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_MIN_SCORE, defaultValue: '70', schema: intRange(0, 100, '公开最低评分'), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_MIN_RELEVANCE, defaultValue: '50', schema: intRange(0, 100, '公开最低相关度'), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_HIDE_ADS, defaultValue: 'true', schema: z.enum(['true', 'false']), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_IMPORTANT_RULE, defaultValue: 'public', schema: z.enum(['auto', 'public', 'hidden']), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_GENERAL_RULE, defaultValue: 'auto', schema: z.enum(['auto', 'public', 'hidden']), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_IRRELEVANT_RULE, defaultValue: 'hidden', schema: z.enum(['auto', 'public', 'hidden']), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.PUBLIC_PIN_HOURS, defaultValue: '24', schema: intRange(1, 720, '重要文章置顶时长'), sensitive: false, exportable: true, frontend: true, seed: true },

  { key: SETTING_KEYS.AUTO_CRAWL_ENABLED, defaultValue: 'false', schema: z.enum(['true', 'false']), sensitive: false, exportable: true, frontend: false, seed: false },
  { key: SETTING_KEYS.CRAWL_INTERVAL_MIN, defaultValue: '120', schema: intRange(5, 10080, '爬取间隔（分钟）'), sensitive: false, exportable: true, frontend: true, seed: true },
  { key: SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT, defaultValue: '', schema: text, sensitive: false, exportable: false, frontend: false, seed: false },
  { key: SETTING_KEYS.SCHEDULER_LAST_PUSH_DATE, defaultValue: '', schema: text, sensitive: false, exportable: false, frontend: false, seed: false },

  { key: SETTING_KEYS.AI_PROVIDER, defaultValue: 'opencode', schema: z.enum(AI_PROVIDER_IDS), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_TEMPERATURE, defaultValue: '0.3', schema: decimalRange(0, 2, '温度'), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_MAX_TOKENS, defaultValue: '10240', schema: intRange(1, 65536, '最大tokens'), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_SYSTEM_PROMPT, defaultValue: DEFAULT_SYSTEM_PROMPT, uiDefaultValue: '', schema: text, sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_STEP2_CONTENT_MAX_CHARS, defaultValue: '5000', schema: intRange(500, 10000, 'Step2正文最大字符数'), sensitive: false, exportable: true, frontend: true, seed: false },

  prompt(SETTING_KEYS.AI_BLOCK_AD, DEFAULT_BLOCK_AD),
  prompt(SETTING_KEYS.AI_BLOCK_EVENT_SCORE, DEFAULT_BLOCK_EVENT_SCORE),
  prompt(SETTING_KEYS.AI_BLOCK_CATEGORY, DEFAULT_BLOCK_CATEGORY),
  prompt(SETTING_KEYS.AI_BLOCK_RELEVANCE, DEFAULT_BLOCK_RELEVANCE),
  prompt(SETTING_KEYS.AI_BLOCK_CONTENT_SCORE, DEFAULT_BLOCK_CONTENT_SCORE),
  prompt(SETTING_KEYS.AI_BLOCK_KEY_POINTS, DEFAULT_BLOCK_KEY_POINTS),
  prompt(SETTING_KEYS.AI_BLOCK_SUMMARY, DEFAULT_BLOCK_SUMMARY),
  prompt(SETTING_KEYS.AI_BLOCK_EVENT_IDENTITY, DEFAULT_BLOCK_EVENT_IDENTITY),
  prompt(SETTING_KEYS.AI_BLOCK_BRAND, DEFAULT_BLOCK_BRAND),

  { key: SETTING_KEYS.AI_WEIGHT_EVENT, defaultValue: String(SCORE_WEIGHT_META.event.defaultWeight), schema: intRange(0, 100, '事件权重'), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_WEIGHT_CONTENT, defaultValue: String(SCORE_WEIGHT_META.content.defaultWeight), schema: intRange(0, 100, '内容权重'), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_KEYWORD_MATCH_BONUS, defaultValue: '5', schema: intRange(0, 20, '关键词命中加分'), sensitive: false, exportable: true, frontend: true, seed: false },
  { key: SETTING_KEYS.AI_CONCURRENCY, defaultValue: '3', schema: intRange(1, 10, 'AI并发数'), sensitive: false, exportable: true, frontend: false, seed: false },

  // Provider 专属配置由 AI_PROVIDERS 契约派生，避免 URL / 默认模型漂移。
  ...providerSettingDefinitions,
];

// 保证提示词元数据新增 key 时不会悄悄脱离配置目录。
for (const id of PROMPT_BLOCK_ORDER) {
  const key = PROMPT_BLOCK_META[id].key;
  if (!definitions.some((definition) => definition.key === key)) {
    throw new Error(`Prompt setting is missing from catalog: ${key}`);
  }
}

export const SETTING_DEFINITIONS = definitions as readonly SettingDefinition[];
export const SETTING_DEFINITION_MAP = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const EXPORTABLE_SETTING_KEYS = SETTING_DEFINITIONS
  .filter((definition) => definition.exportable)
  .map((definition) => definition.key);

const SCHEDULER_RUNTIME_KEYS = new Set<string>([
  SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT,
  SETTING_KEYS.SCHEDULER_LAST_PUSH_DATE,
]);

/** 允许通过 API 写入的配置键。排除纯运行态键（scheduler 状态）。 */
export const WRITABLE_SETTING_KEYS: readonly string[] = SETTING_DEFINITIONS
  .filter((definition) => !SCHEDULER_RUNTIME_KEYS.has(definition.key))
  .map((definition) => definition.key);

export const SENSITIVE_SETTING_KEYS = new Set(
  SETTING_DEFINITIONS.filter((definition) => definition.sensitive).map((definition) => definition.key),
);

export const FRONTEND_SETTING_KEYS = SETTING_DEFINITIONS
  .filter((definition) => definition.frontend)
  .map((definition) => definition.key);

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITION_MAP.get(key);
}

export function getSettingDefaults(options?: { redactSensitive?: boolean }): Record<string, string> {
  const redactSensitive = options?.redactSensitive ?? false;
  return Object.fromEntries(
    SETTING_DEFINITIONS.map((definition) => [
      definition.key,
      redactSensitive && definition.sensitive ? '' : definition.defaultValue,
    ]),
  );
}

export function getExportableSettingDefaults(): Record<string, string> {
  return Object.fromEntries(
    SETTING_DEFINITIONS
      .filter((definition) => definition.exportable)
      .map((definition) => [definition.key, definition.defaultValue]),
  );
}

export function getFrontendSettingDefaults(): Record<string, string> {
  return Object.fromEntries(
    SETTING_DEFINITIONS
      .filter((definition) => definition.frontend)
      .map((definition) => [definition.key, definition.uiDefaultValue ?? definition.defaultValue]),
  );
}

export function getSeedSettingDefaults(): Array<{ key: string; value: string }> {
  return SETTING_DEFINITIONS
    .filter((definition) => definition.seed)
    .map(({ key, defaultValue }) => ({ key, value: defaultValue }));
}
