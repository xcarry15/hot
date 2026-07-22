import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reviewArticle, reviewArticles } from '@/lib/review-service';

const mocks = db as unknown as {
  article: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const serviceMocks = vi.hoisted(() => ({
  refreshPublication: vi.fn(),
  refreshPublications: vi.fn(),
  recalculateArticleEvent: vi.fn(),
  captureInboxSnapshot: vi.fn(),
  invalidatePublicArticleCache: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return { ...actual, getSetting: serviceMocks.getSetting };
});
vi.mock('@/lib/public-publication-service', () => ({
  refreshPublicPublication: serviceMocks.refreshPublication,
  refreshPublicPublications: serviceMocks.refreshPublications,
  updatePublicPublicationSetting: vi.fn(),
}));
vi.mock('@/lib/event-service', () => ({ recalculateArticleEvent: serviceMocks.recalculateArticleEvent }));
vi.mock('@/lib/inbox-snapshot-service', () => ({ captureInboxSnapshot: serviceMocks.captureInboxSnapshot }));
vi.mock('@/lib/public-article-cache', () => ({ invalidatePublicArticleCache: serviceMocks.invalidatePublicArticleCache }));

function transactionClient() {
  return {
    article: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

describe('review-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getSetting.mockImplementation(async (key: string) => {
      if (key.includes('important')) return 'public';
      if (key.includes('irrelevant')) return 'hidden';
      if (key.includes('pin')) return '24';
      return 'auto';
    });
    serviceMocks.refreshPublication.mockResolvedValue(true);
    serviceMocks.refreshPublications.mockResolvedValue(0);
    serviceMocks.recalculateArticleEvent.mockResolvedValue(undefined);
    serviceMocks.captureInboxSnapshot.mockResolvedValue(undefined);
  });

  it('重要归类在同一事务内写入公开覆盖并刷新公开快照', async () => {
    const tx = transactionClient();
    tx.article.update.mockResolvedValue({ id: 'a1', reviewStatus: 'important', publicOverride: 'public' });
    mocks.article.findUnique.mockResolvedValue({ id: 'a1' });
    mocks.$transaction.mockImplementation((operation: (client: ReturnType<typeof transactionClient>) => unknown) => operation(tx));

    await expect(reviewArticle({
      articleId: 'a1',
      status: 'important',
      reasonTags: ['poor_summary', 'unknown'],
    })).resolves.toEqual({
      article: { id: 'a1', reviewStatus: 'important', publicOverride: 'public' },
    });

    expect(tx.article.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' },
      data: expect.objectContaining({
        reviewStatus: 'important',
        reviewReasonTags: JSON.stringify(['poor_summary']),
        publicOverride: 'public',
        pinUntil: expect.any(Date),
      }),
    }));
    expect(serviceMocks.refreshPublication).toHaveBeenCalledWith('a1', tx);
    expect(serviceMocks.recalculateArticleEvent).toHaveBeenCalledWith('a1');
    expect(serviceMocks.invalidatePublicArticleCache).toHaveBeenCalledOnce();
  });

  it('批量归类去重、限制数量，并只重算真实存在的文章', async () => {
    const tx = transactionClient();
    tx.article.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    tx.article.updateMany.mockResolvedValue({ count: 2 });
    mocks.$transaction.mockImplementation((operation: (client: ReturnType<typeof transactionClient>) => unknown) => operation(tx));

    await expect(reviewArticles({
      articleIds: ['a1', 'a1', 'a2'],
      status: 'irrelevant',
    })).resolves.toEqual({ updated: 2 });

    expect(tx.article.findMany).toHaveBeenCalledWith({ where: { id: { in: ['a1', 'a2'] } }, select: { id: true } });
    expect(tx.article.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicOverride: 'hidden', pinUntil: null }),
    }));
    expect(serviceMocks.refreshPublications).toHaveBeenCalledWith(['a1', 'a2'], tx);
    expect(serviceMocks.recalculateArticleEvent).toHaveBeenCalledTimes(2);

    await expect(reviewArticles({
      articleIds: Array.from({ length: 101 }, (_, index) => `a${index}`),
      status: 'general',
    })).rejects.toThrow('单次最多归类 100 篇文章');
  });
});
