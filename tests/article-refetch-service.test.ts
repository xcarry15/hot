import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { refetchArticle } from '@/lib/article-refetch-service';

const mocks = db as unknown as {
  article: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  keyword: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

vi.mock('@/lib/detail-fetcher', () => ({
  fetchArticleDetail: vi.fn(async () => '新的正文内容'),
}));

vi.mock('@/lib/public-publication-service', () => ({
  refreshPublicPublication: vi.fn(async () => true),
}));

describe('article-refetch-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.article.update.mockResolvedValue({});
    mocks.keyword.findMany.mockResolvedValue([]);
  });

  it('文章不存在时返回 null，不执行写入', async () => {
    mocks.article.findUnique.mockResolvedValue(null);
    await expect(refetchArticle('missing')).resolves.toBeNull();
    expect(mocks.article.update).not.toHaveBeenCalled();
  });

  it('重新抓取前重置 AI 状态但保留人工校准契约', async () => {
    mocks.article.findUnique.mockResolvedValue({ id: 'a1' });
    await expect(refetchArticle('a1')).resolves.toEqual({ success: true, contentLength: 6 });
    expect(mocks.article.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' },
      data: expect.objectContaining({
        fetchStatus: 'pending',
        aiStatus: 'pending',
        eventScore: null,
        clusterStatus: 'pending',
        event: { disconnect: true },
      }),
    }));
    expect(mocks.article.update).toHaveBeenLastCalledWith({
      where: { id: 'a1' },
      data: { keywordMatched: false },
    });
  });

  it('重新抓取没有获得有效正文时返回失败，供工作流中断后续阶段', async () => {
    mocks.article.findUnique
      .mockResolvedValueOnce({ id: 'a2' })
      .mockResolvedValueOnce({ fetchError: '来源正文页超时' });
    const { fetchArticleDetail } = await import('@/lib/detail-fetcher');
    vi.mocked(fetchArticleDetail).mockResolvedValueOnce('');

    await expect(refetchArticle('a2')).resolves.toEqual({
      success: false,
      contentLength: 0,
      error: '来源正文页超时',
    });
  });
});
