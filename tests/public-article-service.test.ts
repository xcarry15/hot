import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  getPublicArticleDetail,
  getPublicArticleFeedRevision,
  listPublicArticleIds,
  listPublicArticles,
  recordOriginalClick,
} from '@/lib/public-article-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';

const mocks = db as unknown as {
  article: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  source: { findMany: ReturnType<typeof vi.fn> };
  setting: { findUnique: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

function makeArticle(id: string, publishedAt: string) {
  return {
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
  };
}

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
    mocks.$queryRaw.mockResolvedValue([]);
  });

  it('公开列表使用日期游标，不再接受分页参数', async () => {
    const result = await listPublicArticles({ search: '咖啡' });

    expect(mocks.$queryRaw).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      groups: [],
      displayedArticleCount: 0,
      displayedDateCount: 0,
      nextDate: null,
      hasMore: false,
    });
  });

  it('公开 DTO 不返回管理状态字段', async () => {
    const article = makeArticle('a1', '2026-07-15T01:00:00.000Z');
    mocks.$queryRaw
      .mockResolvedValueOnce([{ date: '2026-07-15', count: 1 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ id: 'a1' }]);
    mocks.article.findMany.mockResolvedValue([article]);
    mocks.article.count.mockResolvedValue(1);
    mocks.article.groupBy.mockResolvedValue([{ sourceId: 's1', _count: { _all: 1 } }]);
    mocks.source.findMany.mockResolvedValue([{ id: 's1', name: '数据源A' }]);

    const result = await listPublicArticles();
    expect(result.items[0]).toMatchObject({ id: 'a1', title: '文章 a1', score: 82 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ date: '2026-07-15', count: 1 });
    expect(result.items[0]).not.toHaveProperty('aiStatus');
    expect(result.items[0]).not.toHaveProperty('isAd');
    expect(result.items[0]).not.toHaveProperty('pushLogs');
  });

  it('搜索统计覆盖全部历史文章', async () => {
    const dateRows = Array.from({ length: 11 }, (_, index) => ({
      date: `2026-07-${String(15 - index).padStart(2, '0')}`,
      count: 1,
    }));
    mocks.$queryRaw
      .mockResolvedValueOnce(dateRows)
      .mockResolvedValueOnce([{ count: 11 }])
      .mockResolvedValueOnce(dateRows.slice(0, 10).map((row) => ({ id: row.date })));
    mocks.article.findMany.mockResolvedValue(
      dateRows.slice(0, 10).map((row) => makeArticle(row.date, `${row.date}T01:00:00.000Z`)),
    );
    mocks.article.count.mockResolvedValue(11);

    const result = await listPublicArticles({ search: '文章' });

    expect(result.total).toBe(11);
    expect(result.displayedDateCount).toBe(10);
    expect(result.displayedArticleCount).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.nextDate).toBe('2026-07-06');
  });

  it('按上海时区分组并使用日期游标，不会把同一天拆开', async () => {
    const articles = [
      makeArticle('a1', '2026-07-15T15:59:00.000Z'),
      makeArticle('a2', '2026-07-15T14:00:00.000Z'),
      makeArticle('a3', '2026-07-14T15:59:00.000Z'),
      makeArticle('a4', '2026-07-14T14:00:00.000Z'),
      makeArticle('a5', '2026-07-13T15:59:00.000Z'),
      makeArticle('a6', '2026-07-12T15:59:00.000Z'),
      makeArticle('a7', '2026-07-11T15:59:00.000Z'),
      makeArticle('a8', '2026-07-10T15:59:00.000Z'),
    ];
    mocks.$queryRaw
      .mockResolvedValueOnce([
        { date: '2026-07-15', count: 2 },
        { date: '2026-07-14', count: 2 },
        { date: '2026-07-13', count: 1 },
        { date: '2026-07-12', count: 1 },
      ])
      .mockResolvedValueOnce([{ count: 8 }])
      .mockResolvedValueOnce([
        { id: 'a1' },
        { id: 'a2' },
        { id: 'a3' },
        { id: 'a4' },
        { id: 'a5' },
      ])
      .mockResolvedValueOnce([
        { date: '2026-07-12', count: 1 },
        { date: '2026-07-11', count: 1 },
        { date: '2026-07-10', count: 1 },
      ])
      .mockResolvedValueOnce([{ count: 8 }])
      .mockResolvedValueOnce([{ id: 'a6' }, { id: 'a7' }, { id: 'a8' }]);
    mocks.article.findMany
      .mockResolvedValueOnce(articles.slice(0, 5))
      .mockResolvedValueOnce(articles.slice(5));
    mocks.article.count.mockResolvedValue(8);

    const firstWindow = await listPublicArticles();
    const olderWindow = await listPublicArticles({ before: firstWindow.nextDate ?? undefined });

    expect(firstWindow.groups.map((group) => group.date)).toEqual([
      '2026-07-15',
      '2026-07-14',
      '2026-07-13',
    ]);
    expect(firstWindow.groups.map((group) => group.count)).toEqual([2, 2, 1]);
    expect(firstWindow.nextDate).toBe('2026-07-13');
    expect(firstWindow.hasMore).toBe(true);
    expect(olderWindow.groups.map((group) => group.date)).toEqual([
      '2026-07-12',
      '2026-07-11',
      '2026-07-10',
    ]);
    expect(olderWindow.items.map((item) => item.id)).toEqual(['a6', 'a7', 'a8']);
  });

  it('单个日期文章很多时仍完整展示', async () => {
    const articles = ['a1', 'a2', 'a3', 'a4'].map((id) => makeArticle(id, '2026-07-15T08:00:00.000Z'));
    mocks.$queryRaw
      .mockResolvedValueOnce([{ date: '2026-07-15', count: 4 }])
      .mockResolvedValueOnce([{ count: 4 }])
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }]);
    mocks.article.findMany.mockResolvedValue(articles);
    mocks.article.count.mockResolvedValue(4);

    const result = await listPublicArticles({ dateLimit: 3 });

    expect(result.hasMore).toBe(false);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(4);
    expect(result.items).toHaveLength(4);
  });

  it('新文章探针只返回筛选结果总数', async () => {
    mocks.$queryRaw.mockResolvedValue([{ count: 12 }]);

    await expect(getPublicArticleFeedRevision({ search: '咖啡' })).resolves.toEqual({ total: 12 });
    expect(mocks.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('不满足公开条件的详情返回 null，供页面映射为 404', async () => {
    await expect(getPublicArticleDetail('private-article')).resolves.toBeNull();
    const where = mocks.article.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'private-article', publicStatus: 'published' });
  });

  it('sitemap 使用公开内容更新时间，不读取互动计数污染的 updatedAt', async () => {
    mocks.article.findMany.mockResolvedValue([{
      id: 'a1',
      publicContentUpdatedAt: new Date('2026-07-16T01:00:00.000Z'),
    }]);

    await expect(listPublicArticleIds()).resolves.toEqual([{
      id: 'a1',
      updatedAt: new Date('2026-07-16T01:00:00.000Z'),
    }]);
  });

  it('原文点击使用原生 SQL 递增，不触发 Prisma updatedAt', async () => {
    mocks.article.findFirst.mockResolvedValue({ id: 'a1' });
    mocks.$executeRaw.mockResolvedValue(1);

    await expect(recordOriginalClick('a1')).resolves.toBe(true);
    expect(mocks.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
