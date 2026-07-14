import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discardedCount: vi.fn(),
  discardedFindMany: vi.fn(),
  articleCount: vi.fn(),
  articleFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    discardedItem: {
      count: mocks.discardedCount,
      findMany: mocks.discardedFindMany,
    },
    article: {
      count: mocks.articleCount,
      findMany: mocks.articleFindMany,
    },
  },
}));

import { getDedupStats } from '@/lib/dedup-stats-service';

describe('dedup-stats-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同时统计采集期 discarded 与 AI 前 Article 去重记录', async () => {
    mocks.discardedCount
      .mockResolvedValueOnce(2) // today
      .mockResolvedValueOnce(5); // all time
    mocks.discardedFindMany.mockResolvedValue([
      { reason: 'dedup:url', detail: JSON.stringify({ similarity: 1 }) },
    ]);
    mocks.articleCount
      .mockResolvedValueOnce(3) // today
      .mockResolvedValueOnce(7); // all time
    mocks.articleFindMany.mockResolvedValue([
      { dedupDetail: JSON.stringify({ methodKey: 'body_lcs', similarity: 0.8 }) },
    ]);

    await expect(getDedupStats()).resolves.toMatchObject({
      todayCount: 5,
      allTimeTotal: 12,
      byType: {
        url_exact: { count: 1, avgSimilarity: 1 },
        near_duplicate: { count: 1, avgSimilarity: 0.8 },
      },
    });
  });
});
