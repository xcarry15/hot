import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DuplicateSourceIdentityError, SourceNotFoundError, getSourceDetail, softDeleteSource, updateSource } from '@/lib/source-service';

const mocks = db as unknown as {
  source: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
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
    mocks.source.findMany.mockResolvedValue([]);
    mocks.source.findFirst.mockResolvedValue({ id: 's1' });
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

  it('编辑 URL 时使用与创建一致的规范化身份拒绝重复来源', async () => {
    mocks.source.findMany.mockResolvedValue([{ name: '已有源', url: 'https://example.com/news/' }]);

    await expect(updateSource('s2', { url: 'https://EXAMPLE.com/news?utm_source=campaign#top' }))
      .rejects.toBeInstanceOf(DuplicateSourceIdentityError);

    expect(mocks.source.update).not.toHaveBeenCalled();
  });

  it('更新或删除不存在、已删除的数据源时返回明确的 404 领域错误', async () => {
    mocks.source.findFirst.mockResolvedValue(null);

    await expect(updateSource('gone', { enabled: false })).rejects.toBeInstanceOf(SourceNotFoundError);
    await expect(softDeleteSource('gone')).rejects.toBeInstanceOf(SourceNotFoundError);
    expect(mocks.source.update).not.toHaveBeenCalled();
  });
});
