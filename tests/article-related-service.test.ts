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
type TestArticle = {
  id: string;
  eventId: string;
  brand: string;
  title: string;
  summary: string;
  score: number;
  createdAt: Date;
  publishedAt: Date | null;
  aiStatus: string;
};

const currentArticle: TestArticle = {
  id: 'article-a',
  eventId: 'event-a',
  brand: JSON.stringify(['品牌A']),
  title: '品牌A的新动态',
  summary: '',
  score: 80,
  createdAt: now,
  publishedAt: now,
  aiStatus: 'done',
};
const relatedArticle: TestArticle = {
  id: 'article-b',
  eventId: 'event-b',
  brand: JSON.stringify(['品牌A']),
  title: '品牌A的历史文章',
  summary: '',
  score: 70,
  createdAt: new Date(now.getTime() - 1_000),
  publishedAt: new Date(now.getTime() - 1_000),
  aiStatus: 'done',
};

function candidate(article: TestArticle, relation: 'same_event' | 'same_brand') {
  const event = { id: article.eventId, firstSeenAt: article.createdAt };
  return {
    ...article,
    url: `https://example.com/${article.id}`,
    source: { name: '测试源', type: 'html' },
    event: relation === 'same_event' ? event : null,
    representedEvent: relation === 'same_brand' ? event : null,
  };
}

describe('getRelatedArticles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === currentArticle.id ? currentArticle : relatedArticle));
    mocks.articleFindMany.mockImplementation(({ where }: { where: { id: { not: string } } }) =>
      Promise.resolve(where.id.not === currentArticle.id
        ? [candidate(relatedArticle, 'same_brand')]
        : [candidate(currentArticle, 'same_brand')]));
  });

  it('同一品牌的文章可以双向看到', async () => {
    const fromCurrent = await getRelatedArticles(currentArticle.id, 5);
    const fromRelated = await getRelatedArticles(relatedArticle.id, 5);

    expect(fromCurrent?.map(({ id }) => id)).toEqual([relatedArticle.eventId]);
    expect(fromRelated?.map(({ id }) => id)).toEqual([currentArticle.eventId]);
  });

  it('不同品牌不会仅因标题或摘要提到当前品牌而命中', async () => {
    const unrelated = {
      ...relatedArticle,
      brand: JSON.stringify(['品牌B']),
      title: '品牌A相关报道',
      id: 'article-unrelated',
    };
    mocks.articleFindUnique.mockResolvedValue(currentArticle);
    mocks.articleFindMany.mockResolvedValue([candidate(unrelated, 'same_brand')]);

    await expect(getRelatedArticles(currentArticle.id, 5)).resolves.toEqual([]);
  });

  it('同事件文章与同品牌文章合并后按时间倒序返回', async () => {
    const sameEventArticle = {
      ...relatedArticle,
      id: 'article-event',
      eventId: currentArticle.eventId,
      brand: JSON.stringify(['品牌B']),
      createdAt: new Date(now.getTime() - 500),
      publishedAt: null,
    };
    mocks.articleFindUnique.mockResolvedValue(currentArticle);
    mocks.articleFindMany.mockResolvedValue([
      candidate(sameEventArticle, 'same_event'),
      candidate(relatedArticle, 'same_brand'),
    ]);

    const related = await getRelatedArticles(currentArticle.id);

    expect(related?.map(({ id, relation }) => `${relation}:${id}`)).toEqual([
      `same_event:${sameEventArticle.id}`,
      `same_brand:${relatedArticle.eventId}`,
    ]);
  });

  it('发布时间为空的新入库文章按创建时间参与排序，不能被窗口过滤', async () => {
    const recentIngestedArticle = {
      ...relatedArticle,
      id: 'article-recent',
      brand: JSON.stringify(['品牌A']),
      createdAt: now,
      publishedAt: null,
    };
    mocks.articleFindUnique.mockResolvedValue(currentArticle);
    mocks.articleFindMany.mockResolvedValue([candidate(recentIngestedArticle, 'same_brand')]);

    const related = await getRelatedArticles(currentArticle.id, 5);

    expect(related?.map(({ id }) => id)).toEqual([recentIngestedArticle.eventId]);
  });

  it('推送场景按已推送 Event 筛选关联文章', async () => {
    await getRelatedArticles(currentArticle.id, 3, { onlyPushed: true });

    expect(mocks.articleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                representedEvent: {
                  is: expect.objectContaining({
                    status: 'active',
                    pushedAt: { not: null },
                  }),
                },
              }),
            ]),
          }),
        ]),
      }),
    }));
  });
});
