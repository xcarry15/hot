import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  getPublicArticleDetail,
  invalidatePublicArticleCache,
  listPublicArticles,
} from '@/lib/public-article-service';

const mocks = db as unknown as {
  article: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  source: { findMany: ReturnType<typeof vi.fn> };
  setting: { findUnique: ReturnType<typeof vi.fn> };
};

describe('public-article-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePublicArticleCache();
    mocks.setting.findUnique.mockResolvedValue({ value: '70' });
    mocks.article.findMany.mockResolvedValue([]);
    mocks.article.count.mockResolvedValue(0);
    mocks.article.groupBy.mockResolvedValue([]);
    mocks.source.findMany.mockResolvedValue([]);
    mocks.article.findFirst.mockResolvedValue(null);
  });

  it('公开列表只查询 AI 完成且达到评分门槛的文章，页面大小固定为 20', async () => {
    await listPublicArticles({ page: 1, pageSize: 100, search: '咖啡' });

    const query = mocks.article.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      aiStatus: 'done',
      score: { gte: 70 },
      source: { deletedAt: null },
      OR: [
        { title: { contains: '咖啡' } },
        { summary: { contains: '咖啡' } },
        { brand: { contains: '咖啡' } },
      ],
    });
    expect(query.take).toBe(20);
    expect(query.orderBy).toEqual([{ publishedAt: 'desc' }, { createdAt: 'desc' }]);
  });

  it('公开 DTO 不返回管理状态字段', async () => {
    mocks.article.findMany.mockResolvedValue([{
      id: 'a1',
      url: 'https://example.com/a1',
      title: '测试文章',
      originalSource: null,
      cleanContent: '<p>正文</p>',
      summary: '摘要',
      brand: '品牌A',
      category: '餐饮',
      tags: '[]',
      score: 82,
      publishedAt: new Date('2026-07-15T00:00:00.000Z'),
      createdAt: new Date('2026-07-15T01:00:00.000Z'),
      source: { id: 's1', name: '数据源A', type: 'html' },
    }]);
    mocks.article.count.mockResolvedValue(1);
    mocks.article.groupBy.mockResolvedValue([{ sourceId: 's1', _count: { _all: 1 } }]);
    mocks.source.findMany.mockResolvedValue([{ id: 's1', name: '数据源A' }]);

    const result = await listPublicArticles();
    expect(result.items[0]).toMatchObject({ id: 'a1', title: '测试文章', score: 82 });
    expect(result.items[0]).not.toHaveProperty('aiStatus');
    expect(result.items[0]).not.toHaveProperty('isAd');
    expect(result.items[0]).not.toHaveProperty('pushLogs');
  });

  it('不满足公开条件的详情返回 null，供页面映射为 404', async () => {
    await expect(getPublicArticleDetail('private-article')).resolves.toBeNull();
    expect(mocks.article.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'private-article',
      aiStatus: 'done',
      score: { gte: 70 },
    });
  });
});
