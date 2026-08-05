import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  articleFindMany: vi.fn(),
  discardedFindMany: vi.fn(),
  fetchLogFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  interactionGroupBy: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: mocks.sourceFindMany },
    article: { findMany: mocks.articleFindMany },
    discardedItem: { findMany: mocks.discardedFindMany },
    fetchLog: { findMany: mocks.fetchLogFindMany },
    job: { findMany: mocks.jobFindMany },
    event: { findMany: mocks.eventFindMany },
    eventInteractionDaily: { groupBy: mocks.interactionGroupBy },
  },
}));

import {
  getDashboardAnalytics,
  getDashboardRangeWindow,
  invalidateDashboardAnalyticsCache,
  parseDashboardAnalyticsRange,
} from '@/lib/dashboard-analytics-service';

describe('运营统计时间与 Event 口径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    invalidateDashboardAnalyticsCache();
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.discardedFindMany.mockResolvedValue([]);
    mocks.fetchLogFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.interactionGroupBy.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([{
      id: 'source-1',
      name: '测试源',
      status: 'normal',
      enabled: true,
      lastFetchedAt: null,
    }]);
  });

  afterEach(() => vi.useRealTimers());

  it('今天是合法范围，且按上海零点切分而非服务器时区', () => {
    expect(parseDashboardAnalyticsRange('today')).toBe('today');
    const window = getDashboardRangeWindow('today', new Date('2026-08-04T18:00:00.000Z'));
    expect(window.startAt?.toISOString()).toBe('2026-08-04T16:00:00.000Z'); // 8/5 00:00 上海
  });

  it('公开浏览只读取互动发生日明细，不会把 Article 生命周期累计值归到入库日', async () => {
    const now = new Date();
    mocks.articleFindMany.mockResolvedValue([{
      id: 'representative', sourceId: 'source-1', createdAt: now,
      fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
      score: 85, isAd: false, event: { articleCount: 1, representativeArticleId: 'representative' },
      // 即使旧 Article 上残留大数，也不能影响概览时间范围。
      viewCount: 999, originalClickCount: 888,
    }]);
    mocks.interactionGroupBy
      .mockResolvedValueOnce([{ sourceId: 'source-1', _sum: { viewCount: 3, originalClickCount: 1 } }])
      .mockResolvedValueOnce([{ eventId: 'e1', _sum: { viewCount: 3, originalClickCount: 1 } }]);
    mocks.eventFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'e1',
        representativeArticle: {
          id: 'representative', title: '浏览最多', publishedAt: now, score: 85, source: { name: '测试源' },
        },
      }]);

    const result = await getDashboardAnalytics('today');

    expect(result.summary.views).toBe(3);
    expect(result.summary.originalClicks).toBe(1);
    expect(result.topViewedArticles).toMatchObject([{ id: 'representative', viewCount: 3 }]);
  });

  it('每日公开与推送按 Event 实际动作时间归档', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T04:00:00.000Z'));
    mocks.articleFindMany.mockResolvedValue([{
      id: 'representative', sourceId: 'source-1', createdAt: new Date('2026-08-05T00:30:00.000Z'),
      fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
      score: 85, isAd: false, event: { articleCount: 1, representativeArticleId: 'representative' },
    }]);
    mocks.eventFindMany.mockResolvedValueOnce([{
      id: 'e1',
      publicPublishedAt: new Date('2026-08-05T01:00:00.000Z'),
      pushedAt: new Date('2026-08-05T02:00:00.000Z'),
      representativeArticle: { sourceId: 'source-1', isAd: false },
    }]);

    const result = await getDashboardAnalytics('today');

    expect(result.dailyNewArticles).toEqual([{
      date: '2026-08-05', count: 1, publicCount: 1, pushedCount: 1,
    }]);
    expect(result.summary.pushed).toBe(1);
  });

  it('同一 Event 只把非代表 Article 计为重复', async () => {
    const now = new Date();
    mocks.articleFindMany.mockResolvedValue([
      {
        id: 'representative', sourceId: 'source-1', createdAt: now,
        fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
        score: 80, isAd: false, event: { articleCount: 2, representativeArticleId: 'representative' },
      },
      {
        id: 'duplicate', sourceId: 'source-1', createdAt: now,
        fetchStatus: 'fetched', aiStatus: 'done', skipReason: null, aiSnapshot: '{}',
        score: 70, isAd: false, event: { articleCount: 2, representativeArticleId: 'representative' },
      },
    ]);

    const result = await getDashboardAnalytics('today');

    expect(result.summary.duplicates).toBe(1);
    expect(result.summary.duplicateArticles).toBe(1);
  });

  it('数据源筛选保留会采集全部数据源的 full 任务，跳过 skipCollect 技术任务', async () => {
    const now = new Date();
    mocks.jobFindMany.mockResolvedValue([
      {
        id: 'full', type: 'full', status: 'succeeded', payload: JSON.stringify({ trigger: 'auto' }), result: '{}', error: '',
        createdAt: now, startedAt: now, completedAt: now, updatedAt: now,
      },
      {
        id: 'repair', type: 'full', status: 'succeeded', payload: JSON.stringify({ skipCollect: true }), result: '{}', error: '',
        createdAt: now, startedAt: now, completedAt: now, updatedAt: now,
      },
    ]);

    const result = await getDashboardAnalytics('today', undefined, { sourceId: 'source-1' });

    expect(result.crawlRecords.map((record) => record.id)).toEqual(['full']);
    expect(result.crawlRecords[0]?.sourceLabel).toBe('全部数据源');
  });
});
