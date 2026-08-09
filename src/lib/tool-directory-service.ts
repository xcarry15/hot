import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import {
  TOOL_CATEGORY_DEFINITIONS,
  TOOL_DIRECTORY_ICON_NAMES,
  TOOL_DIRECTORY_STATUSES,
  TOOL_DIRECTORY_TAG_DEFINITIONS,
  type ToolDirectoryCategoryId,
  type ToolDirectoryIconName,
  type ToolDirectoryItemDto,
  type ToolDirectoryStatus,
  type ToolDirectoryTag,
} from '@/contracts/tool-directory';
import {
  toolCreateSchema,
  type ToolCreateInput,
  type ToolUpdateInput,
} from '@/lib/tool-directory-schema';

export const TOOL_DIRECTORY_CACHE_TAG = 'public-tool-directory';

export class ToolDirectoryNotFoundError extends Error {
  readonly status = 404;
  readonly exposeToClient = true;

  constructor() {
    super('工具不存在或已下架');
    this.name = 'ToolDirectoryNotFoundError';
  }
}

export class ToolDirectoryValidationError extends Error {
  readonly status = 400;
  readonly exposeToClient = true;

  constructor(message: string) {
    super(message);
    this.name = 'ToolDirectoryValidationError';
  }
}

const categoryOrder = new Map<string, number>(
  TOOL_CATEGORY_DEFINITIONS.map((category, index) => [category.id, index]),
);
const iconNameSet = new Set<string>(TOOL_DIRECTORY_ICON_NAMES);
const statusSet = new Set<string>(TOOL_DIRECTORY_STATUSES);
const tagSet = new Set<string>(TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id }) => id));

type StoredTool = Awaited<ReturnType<typeof db.toolDirectoryItem.findUnique>>;

function parseStoredTags(value: string): ToolDirectoryTag[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('工具标签数据格式无效');
  }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string' || !tagSet.has(tag))) {
    throw new Error('工具标签数据无效');
  }
  const tags = parsed as ToolDirectoryTag[];
  if (new Set(tags).size !== tags.length) throw new Error('工具标签数据重复');
  return tags;
}

function mapStoredTool(item: NonNullable<StoredTool>): ToolDirectoryItemDto {
  if (
    !categoryOrder.has(item.category)
    || !iconNameSet.has(item.icon)
    || !statusSet.has(item.status)
  ) {
    throw new Error(`工具数据无效：${item.id}`);
  }

  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category as ToolDirectoryCategoryId,
    href: item.href,
    icon: item.icon as ToolDirectoryIconName,
    status: item.status as ToolDirectoryStatus,
    tags: parseStoredTags(item.tags),
    sortOrder: item.sortOrder,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function sortTools(tools: ToolDirectoryItemDto[]): ToolDirectoryItemDto[] {
  return tools.sort((left, right) => (
    (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER)
      - (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER)
    || left.sortOrder - right.sortOrder
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
  ));
}

function toPublicTool(item: ToolDirectoryItemDto) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    href: item.href,
    icon: item.icon,
    status: item.status,
    tags: item.tags,
  };
}

async function readPublicToolItems(): Promise<ToolDirectoryItemDto[]> {
  const items = await db.toolDirectoryItem.findMany({
    where: { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return sortTools(items.map(mapStoredTool));
}

const readCachedPublicToolItems = unstable_cache(
  readPublicToolItems,
  ['public-tool-directory-items'],
  { revalidate: 3600, tags: [TOOL_DIRECTORY_CACHE_TAG] },
);

export async function getPublicToolCategories() {
  const tools = await readCachedPublicToolItems();
  return TOOL_CATEGORY_DEFINITIONS.map((category) => ({
    id: category.id,
    label: category.label,
    tools: tools
      .filter((tool) => tool.category === category.id)
      .map(toPublicTool),
  }));
}

export async function listToolDirectory(includeArchived = false): Promise<ToolDirectoryItemDto[]> {
  const items = await db.toolDirectoryItem.findMany({
    where: includeArchived ? undefined : { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return sortTools(items.map(mapStoredTool));
}

async function getToolOrThrow(id: string) {
  const item = await db.toolDirectoryItem.findUnique({ where: { id } });
  if (!item) throw new ToolDirectoryNotFoundError();
  return item;
}

async function nextSortOrder(category: string, tx = db) {
  const max = await tx.toolDirectoryItem.aggregate({
    where: { category, archivedAt: null },
    _max: { sortOrder: true },
  });
  return (max._max.sortOrder ?? -1) + 1;
}

function validateCompleteTool(input: unknown): ToolCreateInput {
  const parsed = toolCreateSchema.safeParse(input);
  if (!parsed.success) throw new ToolDirectoryValidationError(parsed.error.issues[0]?.message || '工具参数无效');
  return parsed.data;
}

function invalidatePublicTools(): void {
  revalidatePath('/tools');
  revalidateTag(TOOL_DIRECTORY_CACHE_TAG, 'max');
}

export async function createToolDirectoryItem(input: ToolCreateInput): Promise<ToolDirectoryItemDto> {
  const parsed = validateCompleteTool(input);
  const item = await db.toolDirectoryItem.create({
    data: {
      name: parsed.name,
      description: parsed.description,
      category: parsed.category,
      href: parsed.href || null,
      icon: parsed.icon,
      status: parsed.status,
      tags: JSON.stringify(parsed.tags),
      sortOrder: await nextSortOrder(parsed.category),
    },
  });
  invalidatePublicTools();
  return mapStoredTool(item);
}

export async function updateToolDirectoryItem(id: string, input: ToolUpdateInput): Promise<ToolDirectoryItemDto> {
  const existing = await getToolOrThrow(id);
  const existingDto = mapStoredTool(existing);
  const candidate = validateCompleteTool({
    name: input.name ?? existingDto.name,
    description: input.description ?? existingDto.description,
    category: input.category ?? existingDto.category,
    href: input.href !== undefined ? input.href : existingDto.href,
    icon: input.icon ?? existingDto.icon,
    status: input.status ?? existingDto.status,
    tags: input.tags ?? existingDto.tags,
  });
  const categoryChanged = candidate.category !== existingDto.category;
  const item = await db.toolDirectoryItem.update({
    where: { id },
    data: {
      name: candidate.name,
      description: candidate.description,
      category: candidate.category,
      href: candidate.href || null,
      icon: candidate.icon,
      status: candidate.status,
      tags: JSON.stringify(candidate.tags),
      ...(categoryChanged ? { sortOrder: await nextSortOrder(candidate.category) } : {}),
    },
  });
  invalidatePublicTools();
  return mapStoredTool(item);
}

export async function archiveToolDirectoryItem(id: string): Promise<ToolDirectoryItemDto> {
  await getToolOrThrow(id);
  const item = await db.toolDirectoryItem.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  invalidatePublicTools();
  return mapStoredTool(item);
}

export async function restoreToolDirectoryItem(id: string): Promise<ToolDirectoryItemDto> {
  const existing = await getToolOrThrow(id);
  const item = await db.toolDirectoryItem.update({
    where: { id },
    data: {
      archivedAt: null,
      sortOrder: existing.archivedAt ? await nextSortOrder(existing.category) : existing.sortOrder,
    },
  });
  invalidatePublicTools();
  return mapStoredTool(item);
}

export async function moveToolDirectoryItem(id: string, direction: 'up' | 'down'): Promise<ToolDirectoryItemDto> {
  const item = await db.$transaction(async (tx) => {
    const current = await tx.toolDirectoryItem.findUnique({ where: { id } });
    if (!current || current.archivedAt) throw new ToolDirectoryNotFoundError();
    const siblings = await tx.toolDirectoryItem.findMany({
      where: { category: current.category, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const currentIndex = siblings.findIndex((sibling) => sibling.id === id);
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblings.length) return current;

    const reordered = [...siblings];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    for (const [sortOrder, sibling] of reordered.entries()) {
      await tx.toolDirectoryItem.update({ where: { id: sibling.id }, data: { sortOrder } });
    }
    return tx.toolDirectoryItem.findUniqueOrThrow({ where: { id } });
  });
  invalidatePublicTools();
  return mapStoredTool(item);
}
