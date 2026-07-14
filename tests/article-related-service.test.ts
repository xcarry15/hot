import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleFindUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      findUnique: mocks.articleFindUnique,
    },
  },
}));

import { getRelatedArticles } from '@/lib/article-related-service';

const now = new Date();
const currentArticle = {
  id: 'article-a',
  brand: JSON.stringify(['品牌A']),
  title: '品牌A的新动态',
  summary: '',
  score: 80,
  createdAt: now,
  publishedAt: now,
  aiStatus: 'done',
};
const relatedArticle = {
  id: 'article-b',
  brand: JSON.stringify(['品牌B']),
  title: '品牌B的历史文章',
  summary: '本文回顾了品牌A的市场变化。',
  score: 70,
  createdAt: new Date(now.getTime() - 1_000),
  publishedAt: new Date(now.getTime() - 1_000),
  aiStatus: 'done',
};

describe('getRelatedArticles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === currentArticle.id ? currentArticle : relatedArticle));
    mocks.articleFindMany.mockImplementation(({ where }: {
      where: {
        id: { not: string };
        AND?: Array<{ OR?: Array<{ brand?: { contains?: string; not?: string }; title?: { contains: string }; summary?: { contains: string } }> }>;
      };
    }) => {
      const hasBroadBrandMatch = where.AND?.[0]?.OR?.some((condition) => condition.brand?.not === '') ?? false;
      return Promise.resolve(
        where.id.not === currentArticle.id
          ? [relatedArticle]
          : hasBroadBrandMatch
            ? [currentArticle]
            : [],
      );
    });
  });

  it('同一组相关动态必须能从新文章和历史文章双向看到', async () => {
    const fromNewArticle = await getRelatedArticles(currentArticle.id, 5);
    const fromHistoryArticle = await getRelatedArticles(relatedArticle.id, 5);

    expect(fromNewArticle?.map(({ id }) => id)).toEqual([relatedArticle.id]);
    expect(fromHistoryArticle?.map(({ id }) => id)).toEqual([currentArticle.id]);
  });

  it('历史文章没有品牌字段时，仍能通过其摘要中的品牌反向看到新文章', async () => {
    const unbrandedHistory = {
      ...relatedArticle,
      id: 'article-b-without-brand',
      brand: '[]',
    };
    mocks.articleFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === currentArticle.id ? currentArticle : unbrandedHistory));
    mocks.articleFindMany.mockImplementation(({ where }: { where: { id: { not: string } } }) =>
      Promise.resolve(where.id.not === currentArticle.id ? [unbrandedHistory] : [currentArticle]));

    const fromNewArticle = await getRelatedArticles(currentArticle.id, 5);
    const fromHistoryArticle = await getRelatedArticles(unbrandedHistory.id, 5);

    expect(fromNewArticle?.map(({ id }) => id)).toEqual([unbrandedHistory.id]);
    expect(fromHistoryArticle?.map(({ id }) => id)).toEqual([currentArticle.id]);
  });

  it('发布时间为空的新入库文章按创建时间参与排序，不能在 take 前被截掉', async () => {
    const recentIngestedArticle = {
      ...relatedArticle,
      id: 'article-recent',
      brand: JSON.stringify(['品牌A']),
      createdAt: now,
      publishedAt: null,
    };
    const olderArticles = Array.from({ length: 5 }, (_, index) => ({
      ...relatedArticle,
      id: `article-old-${index}`,
      brand: JSON.stringify(['品牌A']),
      createdAt: new Date(now.getTime() - (index + 2) * 1_000),
      publishedAt: new Date(now.getTime() - (index + 2) * 1_000),
    }));
    mocks.articleFindUnique.mockResolvedValue(currentArticle);
    mocks.articleFindMany.mockResolvedValue([...olderArticles, recentIngestedArticle]);

    const related = await getRelatedArticles(currentArticle.id, 5);

    expect(related?.map(({ id }) => id)).toEqual([
      recentIngestedArticle.id,
      ...olderArticles.slice(0, 4).map(({ id }) => id),
    ]);
  });
});
