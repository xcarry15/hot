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
export const WEBHOOK_MAX_URL_LENGTH = 2048;
export const WEBHOOK_MAX_REMARK_LENGTH = 100;
export const WEBHOOK_MAX_CONFIG_LENGTH = 30_000;

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
 * 服务端持久化前的严格解析。
 *
 * 设置页的编辑态允许存在空 URL 草稿，因此宽松 parser 仍需保留；但 API 不能
 * 只依赖前端约束。此入口会限制数量和长度，并只接收有效 HTTP(S) URL。
 */
export function parseWebhookConfigsForServer(value: string): WebhookConfig[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.length > WEBHOOK_MAX_CONFIG_LENGTH) {
    throw new Error(`Webhook 配置不能超过 ${WEBHOOK_MAX_CONFIG_LENGTH} 个字符`);
  }

  let entries: unknown[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error('Webhook 配置必须是数组');
      entries = parsed;
    } catch (error) {
      if (error instanceof Error && error.message === 'Webhook 配置必须是数组') throw error;
      throw new Error('Webhook 配置 JSON 格式无效');
    }
  } else {
    // 继续接受历史的单个 URL 格式，但保存后统一规范为 JSON 数组。
    entries = [{ url: trimmed, remark: '', enabled: true }];
  }

  if (entries.length > WEBHOOK_MAX_COUNT) {
    throw new Error(`最多支持 ${WEBHOOK_MAX_COUNT} 个 Webhook`);
  }

  const configs: WebhookConfig[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 个 Webhook 格式无效`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.url !== 'string') {
      throw new Error(`第 ${index + 1} 个 Webhook URL 必须是字符串`);
    }
    const url = raw.url.trim();
    // 设置页尚未填写的空草稿不持久化；服务端仍会保留其他有效目标。
    if (!url) continue;
    if (url.length > WEBHOOK_MAX_URL_LENGTH) {
      throw new Error(`第 ${index + 1} 个 Webhook URL 不能超过 ${WEBHOOK_MAX_URL_LENGTH} 个字符`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`第 ${index + 1} 个 Webhook URL 无效`);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(`第 ${index + 1} 个 Webhook URL 仅支持 HTTP(S)`);
    }
    if (raw.remark !== undefined && typeof raw.remark !== 'string') {
      throw new Error(`第 ${index + 1} 个 Webhook 备注必须是字符串`);
    }
    const remark = (raw.remark ?? '').trim();
    if (remark.length > WEBHOOK_MAX_REMARK_LENGTH) {
      throw new Error(`第 ${index + 1} 个 Webhook 备注不能超过 ${WEBHOOK_MAX_REMARK_LENGTH} 个字符`);
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new Error(`第 ${index + 1} 个 Webhook 启用状态必须是布尔值`);
    }
    configs.push({ url, remark, enabled: raw.enabled !== false });
  }
  return configs;
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
