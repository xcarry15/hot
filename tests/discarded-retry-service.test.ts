import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  discardedFindUnique: vi.fn(),
  discardedDelete: vi.fn(),
  articleFindUnique: vi.fn(),
  articleCreate: vi.fn(),
  keywordFindUnique: vi.fn(),
  keywordUpsert: vi.fn(),
  executeRaw: vi.fn(),
  invalidateKeywordCache: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { $transaction: mocks.transaction },
}));

vi.mock('@/lib/filter', () => ({
  invalidateKeywordCache: mocks.invalidateKeywordCache,
}));

import { retryDiscardedItemWithKeyword } from '@/lib/discarded-retry-service';

const tx = {
  discardedItem: {
    findUnique: mocks.discardedFindUnique,
    delete: mocks.discardedDelete,
  },
  article: {
    findUnique: mocks.articleFindUnique,
    create: mocks.articleCreate,
  },
  keyword: {
    findUnique: mocks.keywordFindUnique,
    upsert: mocks.keywordUpsert,
  },
  $executeRaw: mocks.executeRaw,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  mocks.discardedFindUnique.mockResolvedValue({
    id: 'discarded-1',
    sourceId: 'source-1',
    title: '示例文章',
    url: 'https://example.com/1',
    reason: 'filter:keyword',
    detail: '{}',
    winnerArticleId: null,
    publishedAt: null,
    createdAt: new Date(),
  });
  mocks.keywordFindUnique.mockResolvedValue(null);
  mocks.keywordUpsert.mockResolvedValue({ id: 'keyword-1' });
  mocks.articleFindUnique.mockResolvedValue(null);
  mocks.articleCreate.mockResolvedValue({ id: 'article-1', title: '示例文章' });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.discardedDelete.mockResolvedValue({});
});

describe('手动恢复未命中关键词记录', () => {
  it('在同一事务中保存关键词并只消费当前记录', async () => {
    await expect(retryDiscardedItemWithKeyword('discarded-1', {
      word: '咱咱咱',
      category: 'default',
    })).resolves.toMatchObject({
      kind: 'created',
      articleId: 'article-1',
      keyword: { word: '咱咱咱', category: 'default', added: true },
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.keywordUpsert).toHaveBeenCalledWith({
      where: { category_word: { category: 'default', word: '咱咱咱' } },
      create: { category: 'default', word: '咱咱咱' },
      update: {},
    });
    expect(mocks.discardedDelete).toHaveBeenCalledWith({ where: { id: 'discarded-1' } });
    expect(mocks.invalidateKeywordCache).toHaveBeenCalledTimes(1);
  });

  it('当前记录不存在时不写入关键词', async () => {
    mocks.discardedFindUnique.mockResolvedValue(null);

    await expect(retryDiscardedItemWithKeyword('missing', { word: '新词' })).resolves.toEqual({ kind: 'not_found' });

    expect(mocks.keywordUpsert).not.toHaveBeenCalled();
    expect(mocks.invalidateKeywordCache).not.toHaveBeenCalled();
  });

  it('恢复亿邦动力未命中记录时从 URL 回填发布时间', async () => {
    mocks.discardedFindUnique.mockResolvedValue({
      id: 'discarded-1',
      sourceId: 'source-1',
      title: '亿邦动力文章',
      url: 'https://www.ebrun.com/20260804/692331.shtml',
      reason: 'filter:keyword',
      detail: '{}',
      winnerArticleId: null,
      publishedAt: null,
      createdAt: new Date(),
    });

    await retryDiscardedItemWithKeyword('discarded-1');

    expect(mocks.articleCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: new Date('2026-08-04T00:00:00.000Z') }),
    }));
  });
});
