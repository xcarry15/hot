import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  claim: vi.fn(),
  transaction: vi.fn(),
  txFindUnique: vi.fn(),
  txUpdate: vi.fn(),
  recalculate: vi.fn(),
  refreshEvent: vi.fn(),
  refreshArticle: vi.fn(),
  invalidate: vi.fn(),
  analyze: vi.fn(),
  cluster: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: {
  article: { findUnique: mocks.findUnique, updateMany: mocks.claim },
  $transaction: mocks.transaction,
} }));
vi.mock('@/lib/ai', () => ({ reprocessWithAI: mocks.analyze }));
vi.mock('@/lib/article-refetch-service', () => ({ refetchArticle: vi.fn() }));
vi.mock('@/lib/event-clustering-service', () => ({ clusterArticle: mocks.cluster, markClusterFailure: vi.fn() }));
vi.mock('@/lib/event/event-recalculation-service', () => ({ recalculateEventsInTransaction: mocks.recalculate }));
vi.mock('@/lib/public-publication-service', () => ({
  refreshEventPublicPublication: mocks.refreshEvent,
  refreshPublicPublication: mocks.refreshArticle,
}));
vi.mock('@/lib/public-article-cache', () => ({ invalidatePublicArticleCache: mocks.invalidate }));
vi.mock('@/lib/push/delivery', () => ({ getFailedPushTargets: vi.fn(), pushArticleToFeishu: vi.fn() }));

import { executeSingleArticleWorkflow } from '@/lib/execution-article-workflow';

const tx = { article: { findUnique: mocks.txFindUnique, update: mocks.txUpdate } };

describe('单篇重跑的 Event 与公开状态一致性', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: 'a1', title: '新闻', eventId: 'stale-event', updatedAt: new Date(),
      aiStatus: 'failed', clusterStatus: 'failed',
    });
    mocks.claim.mockResolvedValue({ count: 1 });
    mocks.txFindUnique.mockResolvedValue({ eventId: 'current-event' });
    mocks.transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<void>) => operation(tx));
    mocks.analyze.mockResolvedValue({ status: 'skipped' });
    mocks.cluster.mockResolvedValue({ status: 'clustered' });
  });

  it.each(['ai', 'cluster'])('从 %s 重生成时使用事务内的当前 Event，并同步撤销公开投影', async (startAt) => {
    await executeSingleArticleWorkflow({ articleId: 'a1', startAt, intent: 'regenerate' });

    expect(mocks.txUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventId: null, clusterStatus: 'pending' }),
    }));
    expect(mocks.recalculate).toHaveBeenCalledWith(tx, ['current-event']);
    expect(mocks.refreshEvent).toHaveBeenCalledWith('current-event', tx);
    expect(mocks.refreshArticle).toHaveBeenCalledWith('a1', tx);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.refreshArticle.mock.invocationCallOrder[0]!);
  });

  it('聚类技术重试保留 Event 归属，同时重算代表资格', async () => {
    await executeSingleArticleWorkflow({ articleId: 'a1', startAt: 'cluster', intent: 'retry' });

    expect(mocks.txUpdate.mock.calls[0]![0].data).not.toHaveProperty('eventId');
    expect(mocks.recalculate).toHaveBeenCalledWith(tx, ['current-event']);
    expect(mocks.cluster).toHaveBeenCalledTimes(1);
  });

  it('AI 完成后直接聚类，不重复重置已清理的 Event', async () => {
    mocks.analyze.mockResolvedValue({ status: 'done' });

    await executeSingleArticleWorkflow({ articleId: 'a1', startAt: 'ai', intent: 'regenerate' });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.recalculate).toHaveBeenCalledTimes(1);
    expect(mocks.cluster).toHaveBeenCalledTimes(1);
  });

  it.each(['ai', 'cluster'])('从 %s 启动的公开同步失败时中断后续阶段且保留缓存', async (startAt) => {
    mocks.refreshEvent.mockRejectedValue(new Error('publication failed'));

    await expect(executeSingleArticleWorkflow({ articleId: 'a1', startAt, intent: 'regenerate' }))
      .rejects.toThrow('publication failed');
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.cluster).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('认领后文章被删除时停止处理', async () => {
    mocks.txFindUnique.mockResolvedValue(null);

    await expect(executeSingleArticleWorkflow({ articleId: 'a1', startAt: 'ai', intent: 'regenerate' }))
      .rejects.toThrow('文章不存在');
    expect(mocks.txUpdate).not.toHaveBeenCalled();
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
});
