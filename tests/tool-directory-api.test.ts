import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DELETE as deleteCategory } from '@/app/api/tools/categories/[id]/route';
import { POST as createCategory } from '@/app/api/tools/categories/route';
import { POST as createTool } from '@/app/api/tools/route';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (loader: () => unknown) => loader,
}));

const mocks = db as unknown as {
  toolDirectoryCategory: {
    findUnique: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  toolDirectoryItem: {
    findFirst: ReturnType<typeof vi.fn>;
  };
};

function storedCategory(id: string, name: string, sortOrder: number) {
  return {
    id,
    name,
    sortOrder,
    hidden: false,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
  };
}

describe('tool directory API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolDirectoryCategory.findUnique.mockResolvedValue(null);
    mocks.toolDirectoryCategory.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
    mocks.toolDirectoryItem.findFirst.mockResolvedValue(null);
  });

  it('拒绝缺少 HTTPS 链接的正常工具', async () => {
    const response = await createTool(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '示例工具',
        description: '工具简介',
        category: 'business-support',
        href: null,
        icon: 'store',
        status: 'active',
        tags: [],
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('HTTPS') });
  });

  it('创建分类校验通过时返回 201', async () => {
    mocks.toolDirectoryCategory.create.mockResolvedValue(storedCategory('store-opening', '新分类', 5));

    const response = await createCategory(new Request('http://localhost/api/tools/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'store-opening', name: '新分类' }),
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: 'store-opening', name: '新分类' });
  });

  it('创建分类 slug 非法时返回 400', async () => {
    const response = await createCategory(new Request('http://localhost/api/tools/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'Bad_ID', name: '新分类' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('小写字母') });
  });

  it('删除空分类返回成功', async () => {
    mocks.toolDirectoryCategory.findUnique.mockResolvedValue(storedCategory('other-tools', '其他工具', 4));
    mocks.toolDirectoryCategory.delete.mockResolvedValue(storedCategory('other-tools', '其他工具', 4));

    const response = await deleteCategory(
      new Request('http://localhost/api/tools/categories/other-tools', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'other-tools' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'other-tools', name: '其他工具' });
  });

  it('删除非空分类返回错误', async () => {
    mocks.toolDirectoryCategory.findUnique.mockResolvedValue(storedCategory('other-tools', '其他工具', 4));
    mocks.toolDirectoryItem.findFirst.mockResolvedValue({ id: 'tool-1' });

    const response = await deleteCategory(
      new Request('http://localhost/api/tools/categories/other-tools', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'other-tools' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('分类下仍有工具') });
  });
});
