import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { archiveToolDirectoryItem, createToolDirectoryCategory, deleteToolDirectoryCategory, getPublicToolCategories, listToolDirectory } from '@/lib/tool-directory-service';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (loader: () => unknown) => loader,
}));

const mocks = db as unknown as {
  toolDirectoryItem: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  toolDirectoryCategory: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
};

function storedTool(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool-1',
    name: '工具一',
    description: '工具简介',
    category: 'business-support',
    href: 'https://example.com/tool',
    icon: 'store',
    status: 'active',
    tags: '["updated"]',
    sortOrder: 0,
    archivedAt: null,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

function storedCategory(id: string, sortOrder: number, name?: string) {
  const labels: Record<string, string> = {
    'business-support': '业务支持',
    'geo-location': '地理位置',
    'data-analysis': '数据分析',
    'network-planning': '点位分析',
    'other-tools': '其他工具',
  };
  return { id, name: name ?? labels[id], sortOrder, hidden: false, createdAt: new Date(), updatedAt: new Date() };
}

describe('tool-directory-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolDirectoryItem.findMany.mockResolvedValue([]);
    mocks.toolDirectoryItem.findUnique.mockResolvedValue(null);
    mocks.toolDirectoryItem.findFirst.mockResolvedValue(null);
    mocks.toolDirectoryCategory.findUnique.mockResolvedValue(null);
    mocks.toolDirectoryCategory.findMany.mockResolvedValue([
      storedCategory('business-support', 0),
      storedCategory('geo-location', 1),
      storedCategory('data-analysis', 2),
      storedCategory('network-planning', 3),
      storedCategory('other-tools', 4),
    ]);
  });

  it('按维护后的分类顺序返回公开工具，并解析标签', async () => {
    mocks.toolDirectoryCategory.findMany.mockResolvedValue([
      storedCategory('geo-location', 0, '位置工具'),
      storedCategory('business-support', 1, '业务工具'),
      storedCategory('data-analysis', 2),
      storedCategory('network-planning', 3),
      storedCategory('other-tools', 4),
    ]);
    mocks.toolDirectoryItem.findMany.mockResolvedValue([
      storedTool({ id: 'tool-2', category: 'geo-location', sortOrder: 0 }),
      storedTool({ id: 'tool-1', category: 'business-support', sortOrder: 1 }),
    ]);

    const categories = await getPublicToolCategories();

    expect(categories[0].label).toBe('位置工具');
    expect(categories[0].tools[0]).toMatchObject({ id: 'tool-2', tags: ['updated'] });
    expect(categories[1].label).toBe('业务工具');
    expect(categories[1].tools[0]).toMatchObject({ id: 'tool-1' });
    expect(categories).toHaveLength(5);
  });

  it('公开目录不下发不可点击工具的 URL', async () => {
    mocks.toolDirectoryItem.findMany.mockResolvedValue([
      storedTool({ status: 'maintenance' }),
    ]);

    const categories = await getPublicToolCategories();

    expect(categories[0].tools[0]).toMatchObject({
      id: 'tool-1',
      status: 'maintenance',
      href: null,
    });
  });

  it('后台默认隐藏已下架工具，显式查询才返回下架数据', async () => {
    const archived = storedTool({ archivedAt: new Date('2026-08-08T01:00:00.000Z') });
    mocks.toolDirectoryItem.findMany.mockResolvedValue([archived]);

    await listToolDirectory();
    expect(mocks.toolDirectoryItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { archivedAt: null } }));

    await listToolDirectory(true);
    expect(mocks.toolDirectoryItem.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: undefined }));
  });

  it('下架工具使用 archivedAt 软删除，并刷新公开目录缓存', async () => {
    const current = storedTool();
    mocks.toolDirectoryItem.findUnique.mockResolvedValue(current);
    mocks.toolDirectoryItem.update.mockResolvedValue({ ...current, archivedAt: new Date('2026-08-08T02:00:00.000Z') });

    const result = await archiveToolDirectoryItem('tool-1');

    expect(mocks.toolDirectoryItem.update).toHaveBeenCalledWith({
      where: { id: 'tool-1' },
      data: { archivedAt: expect.any(Date) },
    });
    expect(result.archivedAt).toBe('2026-08-08T02:00:00.000Z');
  });

  it('公开页过滤隐藏分类', async () => {
    mocks.toolDirectoryCategory.findMany.mockResolvedValue([
      storedCategory('geo-location', 0, '位置工具'),
      { ...storedCategory('business-support', 1, '业务工具'), hidden: true },
    ]);
    mocks.toolDirectoryItem.findMany.mockResolvedValue([]);
    const categories = await getPublicToolCategories();
    expect(categories.map((c) => c.id)).toEqual(['geo-location']);
  });

  it('创建分类校验 slug 格式与查重', async () => {
    mocks.toolDirectoryCategory.findUnique.mockResolvedValueOnce(null);
    mocks.toolDirectoryCategory.findUnique.mockResolvedValueOnce(null);
    mocks.toolDirectoryCategory.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
    mocks.toolDirectoryCategory.create.mockResolvedValue({ ...storedCategory('store-opening', 5, '新分类'), hidden: false });
    const category = await createToolDirectoryCategory({ id: 'store-opening', name: '新分类' });
    expect(category.id).toBe('store-opening');
    await expect(createToolDirectoryCategory({ id: 'Bad_ID', name: 'x' })).rejects.toThrow('分类标识仅支持小写字母');
  });

  it('删除空分类成功，删除非空分类被拒', async () => {
    mocks.toolDirectoryCategory.findUnique.mockResolvedValue(storedCategory('other-tools', 4, '其他工具'));
    mocks.toolDirectoryItem.findFirst.mockResolvedValue(null);
    mocks.toolDirectoryCategory.delete.mockResolvedValue(storedCategory('other-tools', 4, '其他工具'));
    await expect(deleteToolDirectoryCategory('other-tools')).resolves.toBeTruthy();

    mocks.toolDirectoryItem.findFirst.mockResolvedValue({ id: 'tool-1' });
    await expect(deleteToolDirectoryCategory('other-tools')).rejects.toThrow('分类下仍有工具');
  });
});
