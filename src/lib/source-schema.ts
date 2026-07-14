import { z } from 'zod';

export const SOURCE_TYPES = ['html', 'rss', 'websearch', 'canyin88'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

// enabled 才是开关；status 仅表示采集健康度，不能再用 disabled 重复表达停用状态。
export const SOURCE_STATUSES = ['never_fetched', 'normal', 'warning', 'breaker'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

const sourceUrl = z
  .string()
  .trim()
  .min(1, 'URL 为必填项')
  .max(2048, 'URL 过长')
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL 必须是 http 或 https 地址');

/** UI 当前提交 JSON 字符串；服务端也接受对象，统一在 source-config.ts 序列化。 */
export const parserConfigInput = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

export const sourceCreateSchema = z.object({
  name: z.string().trim().min(1, '名称为必填项').max(200, '名称过长'),
  type: z.enum(SOURCE_TYPES).default('html'),
  url: sourceUrl,
  parserConfig: parserConfigInput.optional().default('{}'),
  enabled: z.boolean().default(true),
}).strict();

export const sourceUpdateSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(200, '名称过长').optional(),
  type: z.enum(SOURCE_TYPES).optional(),
  url: sourceUrl.optional(),
  parserConfig: parserConfigInput.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少提供一个要更新的字段');

export const sourceTestSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  url: sourceUrl,
  parserConfig: parserConfigInput.optional().default('{}'),
}).strict();

export function formatSourceSchemaError(error: z.ZodError): string {
  return error.issues[0]?.message || '数据源参数无效';
}
