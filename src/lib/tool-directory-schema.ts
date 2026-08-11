import { z } from 'zod';
import {
  TOOL_CATEGORY_ID_PATTERN,
  TOOL_DIRECTORY_ICON_NAMES,
  TOOL_DIRECTORY_STATUSES,
  TOOL_DIRECTORY_TAG_DEFINITIONS,
  isToolDirectoryLinkableStatus,
} from '@/contracts/tool-directory';
import { isBlockedOutboundHostname } from '@/lib/outbound-url';

const iconNames = TOOL_DIRECTORY_ICON_NAMES as unknown as [string, ...string[]];
const statuses = TOOL_DIRECTORY_STATUSES as unknown as [string, ...string[]];
const tagIds = TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id }) => id) as [string, ...string[]];

const toolFields = {
  name: z.string().trim().min(1, '名称为必填项').max(100, '名称不能超过 100 个字符'),
  description: z.string().trim().min(1, '简介为必填项').max(500, '简介不能超过 500 个字符'),
  category: z.string().trim().min(1, '请选择分类'),
  href: z.string().trim().max(2048, '链接不能超过 2048 个字符').nullable().optional(),
  icon: z.enum(iconNames as [typeof iconNames[number], ...typeof iconNames[number][]]),
  status: z.enum(statuses as [typeof statuses[number], ...typeof statuses[number][]]),
  tags: z.array(z.enum(tagIds as [typeof tagIds[number], ...typeof tagIds[number][]])).max(tagIds.length, '标签数量过多'),
};

function validateToolLink(value: string | null | undefined, status: string, addIssue: (message: string) => void): void {
  const href = value?.trim() || null;
  if (!href) {
    if (isToolDirectoryLinkableStatus(status as (typeof TOOL_DIRECTORY_STATUSES)[number])) {
      addIssue('可用工具必须填写 HTTPS 链接');
    }
    return;
  }

  try {
    const parsed = new URL(href);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || isBlockedOutboundHostname(parsed.hostname)
    ) {
      addIssue('工具链接必须是合法的公网 HTTPS 地址');
    }
  } catch {
    addIssue('工具链接必须是合法的公网 HTTPS 地址');
  }
}

export const toolCreateSchema = z.object(toolFields).strict().superRefine((value, context) => {
  const duplicateTags = value.tags.filter((tag, index) => value.tags.indexOf(tag) !== index);
  if (duplicateTags.length > 0) {
    context.addIssue({ code: 'custom', path: ['tags'], message: '标签不能重复' });
  }
  validateToolLink(value.href, value.status, (message) => {
    context.addIssue({ code: 'custom', path: ['href'], message });
  });
});

export const toolUpdateSchema = z.object(toolFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  '至少提供一个要更新的字段',
);

export const toolReorderSchema = z.object({
  id: z.string().trim().min(1, '工具 ID 无效'),
  direction: z.enum(['up', 'down']),
}).strict();

export const toolCategoryUpdateSchema = z.object({
  name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
  hidden: z.boolean(),
}).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  '至少提供一个要更新的字段',
);

export const toolCategoryCreateSchema = z.object({
  id: z.string().trim()
    .regex(TOOL_CATEGORY_ID_PATTERN, '分类标识仅支持小写字母、数字与连字符，且以小写字母开头')
    .max(50, '分类标识不能超过 50 个字符'),
  name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
}).strict();

export const toolCategoryReorderSchema = z.object({
  id: z.string().trim().min(1, '分类 ID 无效'),
  direction: z.enum(['up', 'down']),
}).strict();

const toolSnapshotItemSchema = z.object({
  id: z.string().trim().min(1, '工具 ID 无效').max(100, '工具 ID 无效'),
  name: toolFields.name,
  description: toolFields.description,
  category: z.string().trim().min(1, '分类无效'),
  href: z.string().trim().max(2048, '链接不能超过 2048 个字符').nullable(),
  icon: toolFields.icon,
  status: toolFields.status,
  tags: toolFields.tags,
  sortOrder: z.number().int('工具排序无效').min(0, '工具排序无效').max(100_000, '工具排序无效'),
  archivedAt: z.string().datetime({ offset: true, message: '下架时间无效' }).nullable(),
}).strict();

export const toolDirectorySnapshotSchema = z.object({
  categories: z.array(z.object({
    id: z.string().trim().min(1, '分类 ID 无效').max(50, '分类 ID 无效'),
    name: z.string().trim().min(1, '分类名称为必填项').max(30, '分类名称不能超过 30 个字符'),
    sortOrder: z.number().int('分类排序无效').min(0, '分类排序无效').max(100, '分类排序无效'),
    hidden: z.boolean().optional(),
  }).strict()).min(1, '至少需要一个分类').max(50, '分类数量超过上限'),
  tools: z.array(toolSnapshotItemSchema).max(1_000, '工具数量超过上限'),
}).strict().superRefine((value, context) => {
  const categoryIdsInBackup = value.categories.map((category) => category.id);
  if (new Set(categoryIdsInBackup).size !== categoryIdsInBackup.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类 ID 不能重复' });
  }
  if (categoryIdsInBackup.some((id) => !TOOL_CATEGORY_ID_PATTERN.test(id))) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类 ID 仅支持小写字母、数字与连字符' });
  }
  const categoryNames = value.categories.map((category) => category.name.toLocaleLowerCase());
  if (new Set(categoryNames).size !== categoryNames.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类名称不能重复' });
  }
  const sortOrders = value.categories.map((category) => category.sortOrder);
  if (new Set(sortOrders).size !== sortOrders.length) {
    context.addIssue({ code: 'custom', path: ['categories'], message: '分类排序不能重复' });
  }
  const toolIds = value.tools.map((tool) => tool.id);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({ code: 'custom', path: ['tools'], message: '工具 ID 不能重复' });
  }
  for (const [index, tool] of value.tools.entries()) {
    if (!categoryIdsInBackup.includes(tool.category)) {
      context.addIssue({ code: 'custom', path: ['tools', index, 'category'], message: '工具引用了不存在的分类' });
    }
    const parsed = toolCreateSchema.safeParse({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      href: tool.href,
      icon: tool.icon,
      status: tool.status,
      tags: tool.tags,
    });
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        path: ['tools', index],
        message: parsed.error.issues[0]?.message || '工具配置无效',
      });
    }
  }
});

export function formatToolSchemaError(error: z.ZodError): string {
  return error.issues[0]?.message || '工具参数无效';
}

export type ToolCreateInput = z.infer<typeof toolCreateSchema>;
export type ToolUpdateInput = z.infer<typeof toolUpdateSchema>;
export type ToolReorderInput = z.infer<typeof toolReorderSchema>;
export type ToolCategoryCreateInput = z.infer<typeof toolCategoryCreateSchema>;
export type ToolCategoryUpdateInput = z.infer<typeof toolCategoryUpdateSchema>;
export type ToolCategoryReorderInput = z.infer<typeof toolCategoryReorderSchema>;
export type ToolDirectorySnapshotInput = z.infer<typeof toolDirectorySnapshotSchema>;
