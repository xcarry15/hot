import { z } from 'zod';
import {
  TOOL_CATEGORY_DEFINITIONS,
  TOOL_DIRECTORY_ICON_NAMES,
  TOOL_DIRECTORY_STATUSES,
  TOOL_DIRECTORY_TAG_DEFINITIONS,
  isToolDirectoryLinkableStatus,
} from '@/contracts/tool-directory';
import { isBlockedOutboundHostname } from '@/lib/outbound-url';

const categoryIds = TOOL_CATEGORY_DEFINITIONS.map(({ id }) => id) as [string, ...string[]];
const iconNames = TOOL_DIRECTORY_ICON_NAMES as unknown as [string, ...string[]];
const statuses = TOOL_DIRECTORY_STATUSES as unknown as [string, ...string[]];
const tagIds = TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id }) => id) as [string, ...string[]];

const toolFields = {
  name: z.string().trim().min(1, '名称为必填项').max(100, '名称不能超过 100 个字符'),
  description: z.string().trim().min(1, '简介为必填项').max(500, '简介不能超过 500 个字符'),
  category: z.enum(categoryIds as [typeof categoryIds[number], ...typeof categoryIds[number][]]),
  href: z.string().trim().max(2048, '链接不能超过 2048 个字符').nullable().optional(),
  icon: z.enum(iconNames as [typeof iconNames[number], ...typeof iconNames[number][]]),
  status: z.enum(statuses as [typeof statuses[number], ...typeof statuses[number][]]),
  tags: z.array(z.enum(tagIds as [typeof tagIds[number], ...typeof tagIds[number][]])).max(tagIds.length, '标签数量过多'),
};

function validateToolLink(value: string | null | undefined, status: string, addIssue: (message: string) => void): void {
  const href = value?.trim() || null;
  if (!href) {
    if (isToolDirectoryLinkableStatus(status as (typeof TOOL_DIRECTORY_STATUSES)[number])) {
      addIssue('正常或内测工具必须填写 HTTPS 链接');
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

export function formatToolSchemaError(error: z.ZodError): string {
  return error.issues[0]?.message || '工具参数无效';
}

export type ToolCreateInput = z.infer<typeof toolCreateSchema>;
export type ToolUpdateInput = z.infer<typeof toolUpdateSchema>;
export type ToolReorderInput = z.infer<typeof toolReorderSchema>;
