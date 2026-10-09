import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { refetchArticle } from '@/lib/article-refetch-service';
import { fetchArticleDetail, markArticleFetchFailure } from '@/lib/detail-fetcher';
import { recalculateEventsInTransaction } from '@/lib/event-service';
import { invalidateKeywordCache } from '@/lib/filter';
import { refreshEventPublicPublication, refreshPublicPublication } from '@/lib/public-publication-service';

const eventMocks = vi.hoisted(() => ({
  recalculateEventsInTransaction: vi.fn(async () => undefined),
}));

const mocks = db as unknown as {
  article: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
  keyword: {
    findMany: ReturnType<typeof vi.fn>;
  };
  keywordHit: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
};

vi.mock('@/lib/detail-fetcher', () => ({
  ARTICLE_FETCH_TIMEOUT_MS: 30_000,
  fetchArticleDetail: vi.fn(async () => '新的正文内容'),
  markArticleFetchFailure: vi.fn(async () => true),
}));

vi.mock('@/lib/event-service', () => ({
  recalculateEventsInTransaction: eventMocks.recalculateEventsInTransaction,
}));

vi.mock('@/lib/public-publication-service', () => ({
  refreshPublicPublication: vi.fn(async () => true),
  refreshEventPublicPublication: vi.fn(async () => true),
}));

describe('article-refetch-service', () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateKeywordCache();
    mocks.$transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
    mocks.article.update.mockResolvedValue({});
    mocks.keyword.findMany.mockResolvedValue([]);
    mocks.keywordHit.deleteMany.mockResolvedValue({ count: 0 });
    mocks.keywordHit.createMany.mockResolvedValue({ count: 0 });
  });

  it('重跑全文后部的关键词仍保留命中与加分依据', async () => {
    mocks.article.findUnique.mockResolvedValue({ id: 'a1', title: '行业新闻' });
    mocks.keyword.findMany.mockResolvedValue([{ id: 'k1', word: '后部品牌', category: '品牌' }]);
    vi.mocked(fetchArticleDetail).mockResolvedValueOnce('正文'.repeat(600) + '后部品牌');

    await refetchArticle('a1');

    expect(mocks.article.update).toHaveBeenLastCalledWith({
      where: { id: 'a1' }, data: { keywordMatched: true },
    });
    expect(mocks.keywordHit.createMany).toHaveBeenCalledWith({ data: [{ articleId: 'a1', keywordId: 'k1' }] });
  });

  it('停止重跑会中止抓取且不写入迟到的关键词结果', async () => {
    mocks.article.findUnique.mockResolvedValue({ id: 'a1', title: '新闻' });
    const controller = new AbortController();
    vi.mocked(fetchArticleDetail).mockImplementationOnce(async (_id, _retries, signal) => {
      controller.abort(new Error('Stopped by user'));
      // 故意返回迟到结果，检验服务层仍会守住取消边界。
      expect(signal?.aborted).toBe(true);
      return '迟到的正文';
    });

    await expect(refetchArticle('a1', controller.signal)).rejects.toThrow('Stopped by user');
    expect(mocks.article.update).toHaveBeenCalledTimes(1);
    expect(markArticleFetchFailure).not.toHaveBeenCalled();
  });

  it('内部超时会写入可恢复失败，不覆盖已经完成的抓取', async () => {
    vi.useFakeTimers();
    mocks.article.findUnique.mockResolvedValue({ id: 'a1', title: '新闻' });
    vi.mocked(fetchArticleDetail).mockImplementationOnce(() => new Promise(() => {}));
    const result = refetchArticle('a1');
    const rejected = expect(result).rejects.toThrow('正文重新获取超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(markArticleFetchFailure).toHaveBeenCalledWith('a1', expect.any(Error), { onlyIfPending: true });
    expect(mocks.article.update).toHaveBeenCalledTimes(1);
  });

  it('文章不存在时返回 null，不执行写入', async () => {
    mocks.article.findUnique.mockResolvedValue(null);
    await expect(refetchArticle('missing')).resolves.toBeNull();
    expect(mocks.article.update).not.toHaveBeenCalled();
  });

  it('重新抓取前重置 AI 状态但保留人工校准契约', async () => {
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      title: '旧标题',
      cleanContent: '新的正文内容',
      summary: '',
      brand: '',
      eventKey: '',
    });
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
    expect(mocks.keywordHit.deleteMany).toHaveBeenCalledWith({ where: { articleId: 'a1' } });
  });

  it('在同一事务中重算旧 Event 并刷新公开状态', async () => {
    mocks.article.findUnique.mockResolvedValue({
      id: 'a1',
      title: '旧标题',
      eventId: 'event-1',
      manualOverrides: '[]',
      relevance: 0,
      summary: '',
      brand: '',
      category: '',
      eventSubjects: '[]',
      eventAction: '',
      eventObject: '',
      keyPoints: '[]',
      eventScore: null,
      contentScore: null,
      adProbability: null,
      isAd: false,
    });

    await refetchArticle('a1');

    expect(recalculateEventsInTransaction).toHaveBeenCalledWith(db, ['event-1']);
    expect(refreshEventPublicPublication).toHaveBeenCalledWith('event-1', db);
    expect(refreshPublicPublication).toHaveBeenCalledWith('a1', db);
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
