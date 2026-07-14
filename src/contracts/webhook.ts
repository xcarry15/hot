/**
 * Webhook 配置的纯契约。
 *
 * 服务端运行时和客户端设置页共同使用同一份 codec：
 *
 * - 历史格式：纯 URL 字符串会被自动包装为单元素配置。
 * - 当前格式：JSON 数组，元素必须为对象并包含 `url` 字符串字段。
 * - 服务端序列化（持久化前）：过滤掉空 URL，避免无效条目入库。
 * - 客户端序列化（编辑态）：保留所有条目，包括 URL 为空的草稿。
 *
 * 本文件不依赖数据库、网络、React 或 Node API，可在任意环境运行。
 */

export interface WebhookConfig {
  url: string;
  remark: string;
  enabled: boolean;
}

/** 设置页允许配置的最大 Webhook 数量。 */
export const WEBHOOK_MAX_COUNT = 10;

/**
 * 解析 webhook 配置 JSON / 历史纯 URL 字符串。
 *
 * 空串、非 JSON 字符串或 JSON 解析失败均返回空数组；只有 JSON 数组中含
 * `url` 字符串字段的对象会被保留。
 */
export function parseWebhookConfigs(value: string): WebhookConfig[] {
  if (!value || value.trim() === '') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) {
    return [{ url: trimmed, remark: '', enabled: true }];
  }
  try {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (item: unknown) =>
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).url === 'string',
      )
      .map((item: Record<string, unknown>) => ({
        url: String(item.url || ''),
        remark: String(item.remark || ''),
        enabled: item.enabled !== false,
      }));
  } catch {
    return [];
  }
}

/**
 * 服务端序列化：丢弃 URL 为空的配置，仅保留有效目标。
 * 用于持久化到数据库前。
 */
export function serializeWebhookConfigsForServer(configs: WebhookConfig[]): string {
  return JSON.stringify(configs.filter((c) => c.url.trim() !== ''));
}

/**
 * 客户端序列化：保留所有条目，包括 URL 仍为空的草稿。
 * 用于设置页编辑态，使空输入也能被 `parseWebhookConfigs` 完整还原。
 */
export function serializeWebhookConfigsForEditor(configs: WebhookConfig[]): string {
  return JSON.stringify(configs);
}
