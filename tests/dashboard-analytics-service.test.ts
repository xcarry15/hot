import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  discardedFindMany: vi.fn(),
  fetchLogFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  eventFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: mocks.sourceFindMany },
    article: { findMany: mocks.articleFindMany, count: mocks.articleCount },
    discardedItem: { findMany: mocks.discardedFindMany },
    fetchLog: { findMany: mocks.fetchLogFindMany },
    job: { findMany: mocks.jobFindMany },
    event: { findMany: mocks.eventFindMany },
  },
}));

import { getDashboardAnalytics, invalidateDashboardAnalyticsCache, parseDashboardAnalyticsRange } from '@/lib/dashboard-analytics-service';

describe('运营统计重复口径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateDashboardAnalyticsCache();
    mocks.articleCount.mockResolvedValue(0);
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.discardedFindMany.mockResolvedValue([]);
    mocks.fetchLogFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([{
      id: 'source-1',
      name: '测试源',
      status: 'normal',
      enabled: true,
      lastFetchedAt: null,
    }]);
  });

  it('支持全部时间范围', () => {
    expect(parseDashboardAnalyticsRange('all')).toBe('all');
  });

  it('只返回公开事件代表文章中浏览量最高的前 20 篇', async () => {
    mocks.eventFindMany.mockResolvedValue([
      {
        representativeArticle: {
          id: 'article-top',
          title: '浏览最多',
          viewCount: 99,
          publishedAt: new Date('2026-08-05T08:00:00.000Z'),
          score: 92,
          source: { name: '测试源' },
        },
      },
      {
        representativeArticle: {
          id: 'article-second',
          title: '第二名',
          viewCount: 20,
          publishedAt: null,
          score: 78,
          source: { name: '测试源' },
        },
      },
    ]);

    const result = await getDashboardAnalytics('all');

    expect(result.topViewedArticles.map((article) => article.id)).toEqual(['article-top', 'article-second']);
    expect(result.topViewedArticles[0]).toMatchObject({
      publishedAt: '2026-08-05T08:00:00.000Z',
      score: 92,
    });
    expect(mocks.eventFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });

  it('同一 Event 只把非代表 Article 计为重复', async () => {
    const now = new Date();
    mocks.articleFindMany.mockResolvedValue([
      {
        id: 'representative',
        sourceId: 'source-1',
        createdAt: now,
        fetchStatus: 'fetched',
        aiStatus: 'done',
        skipReason: null,
        aiSnapshot: '{}',
        score: 80,
        isAd: false,
        event: { pushedAt: null, articleCount: 2, representativeArticleId: 'representative' },
        viewCount: 0,
        originalClickCount: 0,
      },
      {
        id: 'duplicate',
        sourceId: 'source-1',
        createdAt: now,
        fetchStatus: 'fetched',
        aiStatus: 'done',
        skipReason: null,
        aiSnapshot: '{}',
        score: 70,
        isAd: false,
        event: { pushedAt: null, articleCount: 2, representativeArticleId: 'representative' },
        viewCount: 0,
        originalClickCount: 0,
      },
    ]);

    const result = await getDashboardAnalytics('today');

    expect(result.summary.duplicates).toBe(1);
    expect(result.summary.duplicateArticles).toBe(1);
    expect(result.sources[0].duplicates).toBe(1);
  });

  it('已保留快照的正常跳过稿计入 AI 已分析和软文统计', async () => {
    const now = new Date();
    mocks.articleFindMany.mockResolvedValue([{
      id: 'business-skip',
      sourceId: 'source-1',
      createdAt: now,
      fetchStatus: 'fetched',
      aiStatus: 'skipped',
      skipReason: '无价值',
      aiSnapshot: '{"eventScore":0}',
      score: 20,
      isAd: true,
      event: null,
      viewCount: 0,
      originalClickCount: 0,
    }]);

    const result = await getDashboardAnalytics('today');

    expect(result.summary.analyzed).toBe(1);
    expect(result.summary.ads).toBe(1);
  });

  it('同一已推送 Event 只按代表文章计一次推送', async () => {
    const now = new Date();
    const event = { pushedAt: now, articleCount: 2, representativeArticleId: 'representative' };
    mocks.articleFindMany.mockResolvedValue([
      {
        id: 'representative', sourceId: 'source-1', createdAt: now,
        fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
        score: 85, isAd: false, event, viewCount: 0, originalClickCount: 0,
      },
      {
        id: 'duplicate', sourceId: 'source-1', createdAt: now,
        fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
        score: 80, isAd: false, event, viewCount: 0, originalClickCount: 0,
      },
    ]);

    const result = await getDashboardAnalytics('today');

    expect(result.summary.pushed).toBe(1);
    expect(result.sources[0]?.pushed).toBe(1);
  });
});
