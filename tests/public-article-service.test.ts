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

  it('公开列表只查询 AI 完成且达到评分门槛的文章，按目标 20 篇组织日期分组', async () => {
    const result = await listPublicArticles({ page: 1, pageSize: 20, search: '咖啡' });

    const query = mocks.article.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      aiStatus: 'done',
      source: { deletedAt: null },
    });
    expect(query.where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({ OR: [
        { publicOverride: 'public' },
        { publicOverride: 'auto', score: { gte: 70 } },
      ] }),
      expect.objectContaining({ OR: [
        { title: { contains: '咖啡' } },
        { summary: { contains: '咖啡' } },
        { brand: { contains: '咖啡' } },
      ] }),
    ]));
    expect(query.select).toEqual({ id: true, publishedAt: true, createdAt: true, pinUntil: true });
    expect(result.pageSize).toBe(20);
    expect(result.groups).toEqual([]);
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
      pinUntil: null,
      source: { id: 's1', name: '数据源A', type: 'html' },
    }]);
    mocks.article.count.mockResolvedValue(1);
    mocks.article.groupBy.mockResolvedValue([{ sourceId: 's1', _count: { _all: 1 } }]);
    mocks.source.findMany.mockResolvedValue([{ id: 's1', name: '数据源A' }]);

    const result = await listPublicArticles();
    expect(result.items[0]).toMatchObject({ id: 'a1', title: '测试文章', score: 82 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ date: '2026-07-15', count: 1 });
    expect(result.items[0]).not.toHaveProperty('aiStatus');
    expect(result.items[0]).not.toHaveProperty('isAd');
    expect(result.items[0]).not.toHaveProperty('pushLogs');
  });

  it('不满足公开条件的详情返回 null，供页面映射为 404', async () => {
    await expect(getPublicArticleDetail('private-article')).resolves.toBeNull();
    const where = mocks.article.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'private-article', aiStatus: 'done' });
    expect(where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({ OR: [
        { publicOverride: 'public' },
        { publicOverride: 'auto', score: { gte: 70 } },
      ] }),
    ]));
  });

  it('按上海时区分组分页，不会把同一天拆到不同页面', async () => {
    const makeArticle = (id: string, publishedAt: string) => ({
      id,
      url: `https://example.com/${id}`,
      title: `文章 ${id}`,
      originalSource: null,
      cleanContent: `<p>正文 ${id}</p>`,
      summary: `摘要 ${id}`,
      brand: '品牌A',
      category: '行业',
      tags: '[]',
      score: 82,
      publishedAt: new Date(publishedAt),
      createdAt: new Date(publishedAt),
      pinUntil: null,
      source: { id: 's1', name: '数据源A', type: 'html' },
    });
    const articles = [
      makeArticle('a1', '2026-07-15T15:59:00.000Z'),
      makeArticle('a2', '2026-07-15T14:00:00.000Z'),
      makeArticle('a3', '2026-07-14T15:59:00.000Z'),
      makeArticle('a4', '2026-07-14T14:00:00.000Z'),
    ];
    mocks.article.findMany.mockResolvedValue(articles);
    mocks.article.groupBy.mockResolvedValue([{ sourceId: 's1', _count: { _all: 4 } }]);
    mocks.source.findMany.mockResolvedValue([{ id: 's1', name: '数据源A' }]);

    const firstPage = await listPublicArticles({ page: 1, pageSize: 3 });
    const secondPage = await listPublicArticles({ page: 2, pageSize: 3 });

    expect(firstPage.totalPages).toBe(2);
    expect(firstPage.groups.map((group) => group.date)).toEqual(['2026-07-15']);
    expect(secondPage.groups.map((group) => group.date)).toEqual(['2026-07-14']);
    expect(firstPage.items.map((item) => item.id)).toEqual(['a1', 'a2']);
    expect(secondPage.items.map((item) => item.id)).toEqual(['a3', 'a4']);
  });

  it('单个日期超过目标页大小时仍保持完整', async () => {
    const makeArticle = (id: string) => ({
      id,
      url: `https://example.com/${id}`,
      title: `文章 ${id}`,
      originalSource: null,
      cleanContent: `<p>正文 ${id}</p>`,
      summary: `摘要 ${id}`,
      brand: '品牌A',
      category: '行业',
      tags: '[]',
      score: 82,
      publishedAt: new Date('2026-07-15T08:00:00.000Z'),
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
      pinUntil: null,
      source: { id: 's1', name: '数据源A', type: 'html' },
    });
    const articles = ['a1', 'a2', 'a3', 'a4'].map(makeArticle);
    mocks.article.findMany.mockResolvedValue(articles);
    mocks.article.groupBy.mockResolvedValue([{ sourceId: 's1', _count: { _all: 4 } }]);
    mocks.source.findMany.mockResolvedValue([{ id: 's1', name: '数据源A' }]);

    const result = await listPublicArticles({ page: 1, pageSize: 3 });

    expect(result.totalPages).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(4);
    expect(result.items).toHaveLength(4);
  });
});
