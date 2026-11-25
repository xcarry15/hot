import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleFindFirst: vi.fn(),
  articleUpdate: vi.fn(),
  eventFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  refresh: vi.fn(),
  recalculate: vi.fn(),
}));

const tx = {
  article: { findFirst: mocks.articleFindFirst, update: mocks.articleUpdate },
  event: { findUnique: mocks.eventFindUnique },
  eventClusterAudit: { create: mocks.auditCreate },
};

vi.mock('@/lib/db', () => ({
  db: {
    article: { findMany: mocks.articleFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/public-publication-service', () => ({ refreshEventPublicPublication: mocks.refresh }));
vi.mock('@/lib/public-article-cache', () => ({ invalidatePublicArticleCache: vi.fn() }));
vi.mock('@/lib/event/event-recalculation-service', () => ({
  recalculateEvent: mocks.recalculate,
  releaseRepresentativeOwnership: vi.fn(),
  recalculateEventsInTransaction: vi.fn(),
  reconcileEventAfterArticleDeletionInTransaction: vi.fn(),
}));

import { confirmIndependentBatch } from '@/lib/event-service';

describe('批量确认独立事件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((op: (client: typeof tx) => unknown) => op(tx));
    mocks.articleFindFirst.mockResolvedValue({ id: 'a1' });
    mocks.eventFindUnique.mockResolvedValue({
      status: 'active', clusterReviewStatus: 'pending', _count: { articles: 1 },
    });
    mocks.articleUpdate.mockResolvedValue({});
    mocks.auditCreate.mockResolvedValue({});
    mocks.refresh.mockResolvedValue(true);
    mocks.recalculate.mockResolvedValue(undefined);
  });

  it('成功与失败混合：成功计数，失败逐条给原因且不互相阻断', async () => {
    mocks.articleFindMany.mockResolvedValueOnce([
      { id: 'a1', eventId: 'e1', title: 'A1' },
      { id: 'a2', eventId: 'e2', title: 'A2' },
      { id: 'a3', eventId: 'e3', title: 'A3' },
      { id: 'a4', eventId: null, title: 'A4' },
    ]);
    mocks.eventFindUnique
      .mockResolvedValueOnce({ status: 'active', clusterReviewStatus: 'pending', _count: { articles: 1 } })
      .mockResolvedValueOnce({ status: 'active', clusterReviewStatus: 'confirmed', _count: { articles: 1 } })
      .mockImplementationOnce(() => { throw new Error('boom'); });

    const result = await confirmIndependentBatch(['a1', 'a2', 'a3', 'a4']);
    expect(result.total).toBe(4);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toEqual([
      { articleId: 'a2', title: 'A2', reason: '状态已变更或不符合单篇待复核条件' },
      { articleId: 'a3', title: 'A3', reason: 'boom' },
      { articleId: 'a4', title: 'A4', reason: '文章不存在或未归属事件' },
    ]);
  });

  it('去重并限制单次上限 50 篇', async () => {
    mocks.articleFindMany.mockResolvedValueOnce([]);
    const ids = Array.from({ length: 60 }, (_, index) => `x${index}`);
    const result = await confirmIndependentBatch([...ids, 'x0']);
    expect(result.total).toBe(50);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(50);
    expect(mocks.articleFindMany).toHaveBeenCalledWith({
      where: { id: { in: ids.slice(0, 50) } },
      select: { id: true, eventId: true, title: true },
    });
  });

  it('空输入不查库', async () => {
    const result = await confirmIndependentBatch([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: [] });
    expect(mocks.articleFindMany).not.toHaveBeenCalled();
  });
});
