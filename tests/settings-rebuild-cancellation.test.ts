import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingFindUnique: vi.fn(), settingFindMany: vi.fn(), settingUpdateMany: vi.fn(),
  articleFindMany: vi.fn(), transaction: vi.fn(), publicationRebuild: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: {
  setting: { findUnique: mocks.settingFindUnique, findMany: mocks.settingFindMany, updateMany: mocks.settingUpdateMany },
  article: { findMany: mocks.articleFindMany }, $transaction: mocks.transaction,
} }));
vi.mock('@/lib/event-service', () => ({ recalculateEventsInTransaction: vi.fn() }));
vi.mock('@/lib/public-publication-service', () => ({ rebuildPublicPublicationSnapshotInBatches: mocks.publicationRebuild }));

import { rebuildPendingSettings, SETTINGS_REBUILD_KEY } from '@/lib/settings-rebuild-service';

describe('设置重建取消边界', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settingFindMany.mockResolvedValue([]);
    mocks.settingUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('已经取消时不读取或清除重建标记', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped by user'));
    await expect(rebuildPendingSettings(controller.signal)).rejects.toThrow('Stopped by user');
    expect(mocks.settingFindUnique).not.toHaveBeenCalled();
    expect(mocks.settingUpdateMany).not.toHaveBeenCalled();
  });

  it('文章查询期间取消，不进入分数重建事务或清除标记', async () => {
    const controller = new AbortController();
    mocks.settingFindUnique.mockResolvedValue({ value: JSON.stringify({ id: 'plan', score: true, publication: true }) });
    mocks.articleFindMany.mockImplementationOnce(async () => {
      controller.abort(new Error('Stopped by user'));
      return [{ id: 'a1' }];
    });
    await expect(rebuildPendingSettings(controller.signal)).rejects.toThrow('Stopped by user');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.publicationRebuild).not.toHaveBeenCalled();
    expect(mocks.settingUpdateMany).not.toHaveBeenCalled();
  });

  it('公开重建完成后取消，保留标记供幂等恢复', async () => {
    const controller = new AbortController();
    mocks.settingFindUnique.mockResolvedValue({ value: JSON.stringify({ id: 'plan', score: false, publication: true }) });
    mocks.publicationRebuild.mockImplementationOnce(async () => {
      controller.abort(new Error('Stopped by user'));
      return 100;
    });
    await expect(rebuildPendingSettings(controller.signal)).rejects.toThrow('Stopped by user');
    expect(mocks.publicationRebuild).toHaveBeenCalledWith({ contentChanged: false }, controller.signal);
    expect(mocks.settingUpdateMany).not.toHaveBeenCalled();
  });

  it('正常完成只清除本轮标记', async () => {
    const marker = JSON.stringify({ id: 'plan', score: false, publication: true });
    mocks.settingFindUnique.mockResolvedValue({ value: marker });
    mocks.publicationRebuild.mockResolvedValue(100);
    await expect(rebuildPendingSettings()).resolves.toEqual({ ran: true, recomputed: 0, publicationRebuilt: 100, superseded: false });
    expect(mocks.settingUpdateMany).toHaveBeenCalledWith({ where: { key: SETTINGS_REBUILD_KEY, value: marker }, data: { value: '' } });
  });

  it('第一批提交、后续查询失败时，已提交数据的公开缓存已失效且重建标记保留', async () => {
    const cache = await import('@/lib/public-article-cache');
    const invalidation = vi.spyOn(cache, 'invalidatePublicArticleCache');
    mocks.settingFindUnique.mockResolvedValue({ value: JSON.stringify({ id: 'plan', score: true, publication: true }) });
    mocks.articleFindMany.mockResolvedValueOnce([{ id: 'a1', eventScore: 60, contentScore: 60, isAd: false, keywordMatched: false }])
      .mockRejectedValueOnce(new Error('第二批查询失败'));
    mocks.transaction.mockImplementationOnce(async (operation: (tx: object) => Promise<void>) => operation({ article: { update: vi.fn() } }));
    try {
      await expect(rebuildPendingSettings()).rejects.toThrow('第二批查询失败');
      expect(invalidation).toHaveBeenCalledOnce();
      expect(mocks.settingUpdateMany).not.toHaveBeenCalled();
    } finally {
      invalidation.mockRestore();
    }
  });
});
