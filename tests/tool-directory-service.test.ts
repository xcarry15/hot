import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { archiveToolDirectoryItem, getPublicToolCategories, listToolDirectory } from '@/lib/tool-directory-service';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (loader: () => unknown) => loader,
}));

const mocks = db as unknown as {
  toolDirectoryItem: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
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
    kind: 'open',
    status: 'active',
    tags: '["recommended"]',
    sortOrder: 0,
    archivedAt: null,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('tool-directory-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolDirectoryItem.findMany.mockResolvedValue([]);
    mocks.toolDirectoryItem.findUnique.mockResolvedValue(null);
  });

  it('按固定分类顺序返回公开工具，并解析标签', async () => {
    mocks.toolDirectoryItem.findMany.mockResolvedValue([
      storedTool({ id: 'tool-2', category: 'geo-location', sortOrder: 0 }),
      storedTool({ id: 'tool-1', category: 'business-support', sortOrder: 1 }),
    ]);

    const categories = await getPublicToolCategories();

    expect(categories[0].label).toBe('业务支持');
    expect(categories[0].tools[0]).toMatchObject({ id: 'tool-1', tags: ['recommended'] });
    expect(categories[1].tools[0]).toMatchObject({ id: 'tool-2' });
    expect(categories).toHaveLength(5);
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
});
