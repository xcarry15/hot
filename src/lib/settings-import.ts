/**
 * 配置导入文件的解析与校验(纯函数,便于单测)。
 * 校验信封 type/version,过滤到 EXPORTABLE_SETTING_KEYS 且值为字符串的键。
 * 校验通过后交由 PUT /api/settings 做逐键 zod 校验与事务写入。
 */
import { EXPORTABLE_SETTING_KEYS } from './settings';

export type ParsedImport =
  | { ok: true; settings: Record<string, string> }
  | { ok: false; error: string };

export function parseSettingsImport(raw: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '文件不是合法的 JSON' };
  }

  if (!data || typeof data !== 'object') {
    return { ok: false, error: '文件格式不正确' };
  }
  const obj = data as Record<string, unknown>;

  if (obj.type !== 'hot2-settings') {
    return { ok: false, error: '不是有效的配置文件（type 不匹配）' };
  }
  if (obj.version !== 1) {
    return { ok: false, error: `不支持的配置版本：${String(obj.version)}` };
  }
  if (!obj.settings || typeof obj.settings !== 'object') {
    return { ok: false, error: '配置文件缺少 settings 字段' };
  }

  const src = obj.settings as Record<string, unknown>;
  const exportable = new Set(EXPORTABLE_SETTING_KEYS);
  const settings: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (exportable.has(k) && typeof v === 'string') settings[k] = v;
  }

  return { ok: true, settings };
}
