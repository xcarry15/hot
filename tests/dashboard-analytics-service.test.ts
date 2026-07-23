import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sourceFindMany: vi.fn(),
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  discardedFindMany: vi.fn(),
  fetchLogFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  captureInboxSnapshot: vi.fn(),
  listInboxSnapshots: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    source: { findMany: mocks.sourceFindMany },
    article: { findMany: mocks.articleFindMany, count: mocks.articleCount },
    discardedItem: { findMany: mocks.discardedFindMany },
    fetchLog: { findMany: mocks.fetchLogFindMany },
    job: { findMany: mocks.jobFindMany },
  },
}));

vi.mock('@/lib/inbox-snapshot-service', () => ({
  captureInboxSnapshotForDashboard: mocks.captureInboxSnapshot,
  listInboxSnapshots: mocks.listInboxSnapshots,
}));

import { getDashboardAnalytics, invalidateDashboardAnalyticsCache } from '@/lib/dashboard-analytics-service';

describe('运营统计重复口径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateDashboardAnalyticsCache();
    mocks.captureInboxSnapshot.mockResolvedValue(undefined);
    mocks.listInboxSnapshots.mockResolvedValue([]);
    mocks.articleCount.mockResolvedValue(0);
    mocks.discardedFindMany.mockResolvedValue([]);
    mocks.fetchLogFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.sourceFindMany.mockResolvedValue([{
      id: 'source-1',
      name: '测试源',
      status: 'normal',
      enabled: true,
      lastFetchedAt: null,
    }]);
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
      skipReason: '无具体事件',
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
});
