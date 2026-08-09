import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import {
  TOOL_CATEGORY_SEED_DEFINITIONS,
  TOOL_DIRECTORY_ICON_NAMES,
  TOOL_DIRECTORY_STATUSES,
  TOOL_DIRECTORY_TAG_DEFINITIONS,
  type ToolDirectoryBackupPayload,
  type ToolDirectoryCategoryDto,
  type ToolDirectoryCategoryId,
  type ToolDirectoryIconName,
  type ToolDirectoryItemDto,
  type ToolDirectoryStatus,
  type ToolDirectoryTag,
} from '@/contracts/tool-directory';
import {
  toolCreateSchema,
  toolDirectoryBackupSchema,
  type ToolCategoryUpdateInput,
  type ToolCreateInput,
  type ToolDirectoryBackupInput,
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

const categoryIdSet = new Set<string>(TOOL_CATEGORY_SEED_DEFINITIONS.map(({ id }) => id));
const iconNameSet = new Set<string>(TOOL_DIRECTORY_ICON_NAMES);
const statusSet = new Set<string>(TOOL_DIRECTORY_STATUSES);
const tagSet = new Set<string>(TOOL_DIRECTORY_TAG_DEFINITIONS.map(({ id }) => id));

type StoredTool = Awaited<ReturnType<typeof db.toolDirectoryItem.findUnique>>;
type StoredCategory = Awaited<ReturnType<typeof db.toolDirectoryCategory.findUnique>>;

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

function mapStoredCategory(category: NonNullable<StoredCategory>): ToolDirectoryCategoryDto {
  if (!categoryIdSet.has(category.id)) throw new Error(`工具分类数据无效：${category.id}`);
  return {
    id: category.id as ToolDirectoryCategoryId,
    name: category.name,
    sortOrder: category.sortOrder,
  };
}

function mapStoredTool(item: NonNullable<StoredTool>): ToolDirectoryItemDto {
  if (
    !categoryIdSet.has(item.category)
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

function sortTools(
  tools: ToolDirectoryItemDto[],
  categories: readonly ToolDirectoryCategoryDto[],
): ToolDirectoryItemDto[] {
  const categoryOrder = new Map(categories.map((category, index) => [category.id, index]));
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

async function readToolItems(includeArchived: boolean): Promise<ToolDirectoryItemDto[]> {
  const items = await db.toolDirectoryItem.findMany({
    where: includeArchived ? undefined : { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return items.map(mapStoredTool);
}

export async function listToolDirectoryCategories(): Promise<ToolDirectoryCategoryDto[]> {
  const categories = await db.toolDirectoryCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return categories.map(mapStoredCategory);
}

async function readPublicToolCategories() {
  const [categories, tools] = await Promise.all([
    listToolDirectoryCategories(),
    readToolItems(false),
  ]);
  const sortedTools = sortTools(tools, categories);
  return categories.map((category) => ({
    id: category.id,
    label: category.name,
    tools: sortedTools
      .filter((tool) => tool.category === category.id)
      .map(toPublicTool),
  }));
}

const readCachedPublicToolCategories = unstable_cache(
  readPublicToolCategories,
  ['public-tool-directory-categories'],
  { revalidate: 3600, tags: [TOOL_DIRECTORY_CACHE_TAG] },
);

export async function getPublicToolCategories() {
  return readCachedPublicToolCategories();
}

export async function listToolDirectory(includeArchived = false): Promise<ToolDirectoryItemDto[]> {
  const [categories, tools] = await Promise.all([
    listToolDirectoryCategories(),
    readToolItems(includeArchived),
  ]);
  return sortTools(tools, categories);
}

async function getToolOrThrow(id: string) {
  const item = await db.toolDirectoryItem.findUnique({ where: { id } });
  if (!item) throw new ToolDirectoryNotFoundError();
  return item;
}

async function getCategoryOrThrow(id: string, tx = db) {
  if (!categoryIdSet.has(id)) throw new ToolDirectoryValidationError('工具分类不存在');
  const category = await tx.toolDirectoryCategory.findUnique({ where: { id } });
  if (!category) throw new ToolDirectoryValidationError('工具分类不存在');
  return category;
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
  await getCategoryOrThrow(parsed.category);
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
  if (categoryChanged) await getCategoryOrThrow(candidate.category);
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

export async function updateToolDirectoryCategory(
  id: ToolDirectoryCategoryId,
  input: ToolCategoryUpdateInput,
): Promise<ToolDirectoryCategoryDto> {
  await getCategoryOrThrow(id);
  const duplicate = await db.toolDirectoryCategory.findUnique({ where: { name: input.name } });
  if (duplicate && duplicate.id !== id) throw new ToolDirectoryValidationError('分类名称已存在');
  const category = await db.toolDirectoryCategory.update({
    where: { id },
    data: { name: input.name },
  });
  invalidatePublicTools();
  return mapStoredCategory(category);
}

export async function moveToolDirectoryCategory(
  id: ToolDirectoryCategoryId,
  direction: 'up' | 'down',
): Promise<ToolDirectoryCategoryDto> {
  const category = await db.$transaction(async (tx) => {
    const categories = await tx.toolDirectoryCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const currentIndex = categories.findIndex((item) => item.id === id);
    if (currentIndex < 0) throw new ToolDirectoryValidationError('工具分类不存在');
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= categories.length) return categories[currentIndex];

    const reordered = [...categories];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    for (const [sortOrder, item] of reordered.entries()) {
      await tx.toolDirectoryCategory.update({ where: { id: item.id }, data: { sortOrder } });
    }
    return tx.toolDirectoryCategory.findUniqueOrThrow({ where: { id } });
  });
  invalidatePublicTools();
  return mapStoredCategory(category);
}

export async function exportToolDirectoryBackup(): Promise<ToolDirectoryBackupPayload> {
  const [storedCategories, storedTools] = await db.$transaction([
    db.toolDirectoryCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.toolDirectoryItem.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  const categories = storedCategories.map(mapStoredCategory);
  const tools = sortTools(storedTools.map(mapStoredTool), categories);
  return {
    type: 'hot2-tool-directory-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    categories,
    tools: tools.map(({ id, name, description, category, href, icon, status, tags, sortOrder, archivedAt }) => ({
      id,
      name,
      description,
      category,
      href,
      icon,
      status,
      tags,
      sortOrder,
      archivedAt,
    })),
  };
}

export async function restoreToolDirectoryBackup(input: unknown): Promise<{ categoryCount: number; toolCount: number }> {
  const parsed = toolDirectoryBackupSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolDirectoryValidationError(parsed.error.issues[0]?.message || '工具中心备份文件无效');
  }
  const backup = parsed.data as ToolDirectoryBackupInput;
  await db.$transaction(async (tx) => {
    await tx.toolDirectoryItem.deleteMany();
    await tx.toolDirectoryCategory.deleteMany();
    await tx.toolDirectoryCategory.createMany({
      data: backup.categories.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
      })),
    });
    if (backup.tools.length > 0) {
      await tx.toolDirectoryItem.createMany({
        data: backup.tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          category: tool.category,
          href: tool.href,
          icon: tool.icon,
          status: tool.status,
          tags: JSON.stringify(tool.tags),
          sortOrder: tool.sortOrder,
          archivedAt: tool.archivedAt ? new Date(tool.archivedAt) : null,
        })),
      });
    }
  });
  invalidatePublicTools();
  return { categoryCount: backup.categories.length, toolCount: backup.tools.length };
}
