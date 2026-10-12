import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  articleFindMany: vi.fn(),
  articleGroupBy: vi.fn(),
  articleCount: vi.fn(),
  discardedFindMany: vi.fn(),
  fetchLogFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  interactionGroupBy: vi.fn(),
  aiInvocationGroupBy: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: mocks.sourceFindMany },
    article: {
      findMany: mocks.articleFindMany,
      groupBy: mocks.articleGroupBy,
      count: mocks.articleCount,
    },
    discardedItem: { findMany: mocks.discardedFindMany },
    fetchLog: { findMany: mocks.fetchLogFindMany },
    job: { findMany: mocks.jobFindMany },
    event: { findMany: mocks.eventFindMany },
    eventInteractionDaily: { groupBy: mocks.interactionGroupBy },
    aiInvocation: { groupBy: mocks.aiInvocationGroupBy },
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
    mocks.articleGroupBy.mockResolvedValue([]);
    mocks.articleCount.mockResolvedValue(0);
    mocks.discardedFindMany.mockResolvedValue([]);
    mocks.fetchLogFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.interactionGroupBy.mockResolvedValue([]);
    mocks.aiInvocationGroupBy.mockResolvedValue([]);
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
        id: 'full', type: 'full', status: 'succeeded', payload: JSON.stringify({ trigger: 'auto' }), result: JSON.stringify({ stages: { collect: { totalNewArticles: 3, sources: [{ itemsFound: 12, newArticles: 3 }] } } }), error: '',
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
    expect(result.crawlRecords[0]?.newArticles).toBe(3);
  });

  it('按 Job 结果累计 AI 失败和延期次数，并独立显示当前可处理与放弃文章', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T04:00:00.000Z'));
    mocks.jobFindMany
      .mockResolvedValueOnce([
        {
          type: 'full',
          result: JSON.stringify({ stages: { ai: { errors: 2, deferred: 7, providerPaused: true } } }),
        },
        {
          type: 'ai',
          result: JSON.stringify({ result: { errors: 1, deferred: 3, providerUnavailable: true } }),
        },
        {
          type: 'ai',
          result: JSON.stringify({ articleId: 'article-failed', result: { status: 'failed' } }),
        },
        {
          type: 'ai',
          result: JSON.stringify({ articleId: 'article-deferred', result: { status: 'deferred', globalError: true } }),
        },
        {
          type: 'ai',
          result: JSON.stringify({ articleId: 'workflow-failed', startAt: 'ai', stages: ['ai'], ai: { status: 'failed' } }),
        },
        {
          type: 'ai',
          result: JSON.stringify({ articleId: 'workflow-deferred', startAt: 'ai', stages: ['ai'], ai: { status: 'deferred', globalError: true } }),
        },
        {
          type: 'process',
          status: 'succeeded',
          result: JSON.stringify({ articleId: 'process-workflow-failed', startAt: 'process', stages: ['process', 'ai'], ai: { status: 'failed' } }),
        },
        {
          type: 'process',
          status: 'succeeded',
          result: JSON.stringify({ articleId: 'process-workflow-deferred', startAt: 'process', stages: ['process', 'ai'], ai: { status: 'deferred', globalError: true } }),
        },
        {
          type: 'process',
          status: 'succeeded',
          result: JSON.stringify({ total: 1, processed: 1, errors: 0 }),
        },
        {
          type: 'full',
          result: JSON.stringify({ stages: { ai: { errors: -1, deferred: 1.5, providerPaused: 'true' } } }),
        },
        { type: 'ai', result: '{invalid json' },
        { type: 'ai', status: 'failed', result: '{}' },
      ])
      .mockResolvedValueOnce([]);
    mocks.articleGroupBy
      .mockResolvedValueOnce([
        { aiStatus: 'pending', _count: { _all: 4 } },
        { aiStatus: 'failed', _count: { _all: 2 } },
        { aiStatus: 'skipped', _count: { _all: 99 } },
      ])
      .mockResolvedValueOnce([
        { aiStatus: 'pending', _count: { _all: 3 } },
        { aiStatus: 'failed', _count: { _all: 1 } },
      ]);
    mocks.articleCount.mockResolvedValue(1);

    const result = await getDashboardAnalytics('today');

    expect(result.ai.processing).toEqual({
      period: { failedAttempts: 6, deferredOccurrences: 13, providerPausedJobs: 5, failedJobs: 1 },
      current: { ready: 6, cooling: 4, failed: 3, abandoned: 1 },
    });
    expect(mocks.jobFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        type: { in: ['full', 'ai', 'process'] },
        createdAt: { gte: new Date('2026-08-04T16:00:00.000Z'), lte: new Date('2026-08-05T04:00:00.000Z') },
      },
      select: { type: true, result: true, status: true },
    });
    expect(mocks.articleGroupBy).toHaveBeenNthCalledWith(1, {
      by: ['aiStatus'],
      where: {
        fetchStatus: 'fetched',
        technicalIgnoredAt: null,
        eventId: null,
        clusterStatus: 'pending',
        source: { is: { deletedAt: null } },
        aiStatus: { in: ['pending', 'failed'] },
        OR: [
          { nextAiRetryAt: null },
          { nextAiRetryAt: { lte: new Date('2026-08-05T04:00:00.000Z') } },
        ],
      },
      _count: { _all: true },
    });
    expect(mocks.articleGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['aiStatus'],
      where: {
        fetchStatus: 'fetched',
        technicalIgnoredAt: null,
        eventId: null,
        clusterStatus: 'pending',
        source: { is: { deletedAt: null } },
        aiStatus: { in: ['pending', 'failed'] },
        nextAiRetryAt: { gt: new Date('2026-08-05T04:00:00.000Z') },
      },
      _count: { _all: true },
    });
    expect(mocks.articleCount).toHaveBeenCalledWith({
      where: {
        fetchStatus: 'fetched',
        aiStatus: 'skipped',
        skipReason: { startsWith: 'AI 连续失败' },
        source: { is: { deletedAt: null } },
      },
    });
  });

  it('来源筛选下只显示来源文章队列，不混入无法归属来源的全局 Job 计数', async () => {
    mocks.articleGroupBy
      .mockResolvedValueOnce([{ aiStatus: 'pending', _count: { _all: 2 } }])
      .mockResolvedValueOnce([]);

    const result = await getDashboardAnalytics('today', 'source-1');

    expect(result.ai.processing).toEqual({
      period: null,
      current: { ready: 2, cooling: 0, failed: 0, abandoned: 0 },
    });
    expect(mocks.jobFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.articleGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceId: 'source-1' }),
    }));
    expect(mocks.articleCount).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceId: 'source-1' }),
    }));
  });
});
