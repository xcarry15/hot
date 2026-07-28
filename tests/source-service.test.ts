import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getSourceDetail, softDeleteSource, updateSource } from '@/lib/source-service';

const mocks = db as unknown as {
  source: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  fetchLog: { findMany: ReturnType<typeof vi.fn> };
};

const sourceServiceMocks = vi.hoisted(() => ({
  refreshPublicationsForSource: vi.fn(),
  invalidatePublicArticleCache: vi.fn(),
}));

vi.mock('@/lib/public-publication-service', () => ({
  refreshPublicPublicationsForSource: sourceServiceMocks.refreshPublicationsForSource,
}));
vi.mock('@/lib/public-article-cache', () => ({
  invalidatePublicArticleCache: sourceServiceMocks.invalidatePublicArticleCache,
}));

describe('source-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceServiceMocks.refreshPublicationsForSource.mockResolvedValue(0);
  });

  it('已删除来源不会暴露详情', async () => {
    mocks.source.findUnique.mockResolvedValue({ id: 's1', deletedAt: new Date(), _count: { articles: 3 } });
    await expect(getSourceDetail('s1')).resolves.toBeNull();
    expect(mocks.fetchLog.findMany).not.toHaveBeenCalled();
  });

  it('修改公开开关后分批刷新来源公开快照，不把全量文章塞进来源事务', async () => {
    mocks.source.update.mockResolvedValue({ id: 's1', publicEnabled: false });

    await expect(updateSource('s1', { publicEnabled: false })).resolves.toEqual({ id: 's1', publicEnabled: false });

    expect(mocks.source.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { publicEnabled: false } });
    expect(sourceServiceMocks.refreshPublicationsForSource).toHaveBeenCalledWith('s1');
    expect(sourceServiceMocks.invalidatePublicArticleCache).toHaveBeenCalledOnce();
  });

  it('软删除来源会禁用采集并撤回该来源公开内容', async () => {
    mocks.source.update.mockResolvedValue({ id: 's1', enabled: false });

    await softDeleteSource('s1');

    expect(mocks.source.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { deletedAt: expect.any(Date), enabled: false },
    });
    expect(sourceServiceMocks.refreshPublicationsForSource).toHaveBeenCalledWith('s1');
    expect(sourceServiceMocks.invalidatePublicArticleCache).toHaveBeenCalledOnce();
  });
});
