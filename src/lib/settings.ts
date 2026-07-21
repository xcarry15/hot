/**
 * 统一的 Setting 读写层 + 所有 Key 常量。
 *
 * 历史：push.ts / scheduler.ts 各自定义了同名的 getSetting()，
 * ai-client.ts 内联加载所有 settings，缺少统一的 Key 清单。
 * 现在收敛到此文件。
 */

import { db } from './db';
export {
  EXPORTABLE_SETTING_KEYS,
  WRITABLE_SETTING_KEYS,
  FRONTEND_SETTING_KEYS,
  SETTING_DEFINITIONS,
  SETTING_DEFINITION_MAP,
  SETTING_KEYS,
  SENSITIVE_SETTING_KEYS,
  getFrontendSettingDefaults,
  getExportableSettingDefaults,
  getSeedSettingDefaults,
  getSettingDefinition,
  getSettingDefaults,
} from './settings-catalog';
export type { SettingDefinition, SettingKey } from './settings-catalog';
import {
  getSettingDefinition,
  getSettingDefaults,
  SETTING_DEFINITION_MAP,
  SETTING_KEYS,
} from './settings-catalog';
import { DEFAULT_PROMPT_SETTINGS } from './prompts';
import type { WebhookConfig } from '@/contracts/webhook';
import {
  parseWebhookConfigs,
  serializeWebhookConfigsForServer,
} from '@/contracts/webhook';

// ── 读写函数 ──────────────────────────────────────────────────────

/** 读取单个 Setting 值（不存在时返回配置目录中的默认值） */
export async function getSetting(key: string): Promise<string> {
  const s = await db.setting.findUnique({ where: { key } });
  return resolveSettingValue(key, s?.value);
}

function resolveSettingValue(key: string, value: string | null | undefined): string {
  if (key in DEFAULT_PROMPT_SETTINGS) {
    return value?.trim()
      ? value
      : DEFAULT_PROMPT_SETTINGS[key as keyof typeof DEFAULT_PROMPT_SETTINGS];
  }
  return value ?? getSettingDefinition(key)?.defaultValue ?? '';
}

/** 写入或更新单个 Setting */
export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/** 一次性读取全部 Setting，返回 key→value 映射 */
export async function readAllSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany();
  const map = getSettingDefaults();
  for (const s of rows) {
    if (!SETTING_DEFINITION_MAP.has(s.key)) continue;
    map[s.key] = resolveSettingValue(s.key, s.value);
  }
  return map;
}

// ── Webhook 配置 ──────────────────────────────────────────────────
//
// Webhook 的纯 codec（结构、parse、两种 serialize）统一在 `@/contracts/webhook`。
// 这里只保留服务端专属的读取入口和向后兼容别名，避免服务端调用方在多
// 个批次里同步修改。

export type { WebhookConfig } from '@/contracts/webhook';
export { parseWebhookConfigs } from '@/contracts/webhook';

/**
 * 向后兼容的服务端序列化别名：行为等价于 `serializeWebhookConfigsForServer`，
 * 丢弃 URL 为空的配置。
 */
export function serializeWebhookConfigs(configs: WebhookConfig[]): string {
  return serializeWebhookConfigsForServer(configs);
}

/** 从数据库读取并解析 webhook 配置 */
export async function getWebhookConfigs(): Promise<WebhookConfig[]> {
  const raw = await getSetting(SETTING_KEYS.FEISHU_WEBHOOK_URL);
  return parseWebhookConfigs(raw);
}

/** 便捷方法：返回所有启用的 webhook URL 列表 */
export async function getEnabledWebhookUrls(): Promise<string[]> {
  const configs = await getWebhookConfigs();
  return configs.filter(c => c.enabled && c.url.trim() !== '').map(c => c.url.trim());
}
