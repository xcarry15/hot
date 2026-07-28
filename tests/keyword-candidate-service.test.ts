import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidateFindUnique: vi.fn(),
  candidateUpdate: vi.fn(),
  candidateDelete: vi.fn(),
  keywordUpsert: vi.fn(),
  keywordDeleteMany: vi.fn(),
  discardedFindMany: vi.fn(),
  discardedDeleteMany: vi.fn(),
  transaction: vi.fn(),
  retryDiscardedItem: vi.fn(),
  invalidateKeywordCache: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    keywordCandidate: {
      findUnique: mocks.candidateFindUnique,
      update: mocks.candidateUpdate,
      delete: mocks.candidateDelete,
    },
    keyword: {
      upsert: mocks.keywordUpsert,
      deleteMany: mocks.keywordDeleteMany,
    },
    discardedItem: {
      findMany: mocks.discardedFindMany,
      deleteMany: mocks.discardedDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/discarded-retry-service', () => ({
  retryDiscardedItem: mocks.retryDiscardedItem,
}));

vi.mock('@/lib/filter', () => ({
  invalidateKeywordCache: mocks.invalidateKeywordCache,
}));

import { deleteKeywordCandidate, updateKeywordCandidate } from '../src/lib/keyword-candidate-service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keywordUpsert.mockResolvedValue({});
  mocks.keywordDeleteMany.mockResolvedValue({ count: 1 });
  mocks.candidateUpdate.mockResolvedValue({});
  mocks.candidateDelete.mockResolvedValue({});
  mocks.discardedFindMany.mockResolvedValue([]);
  mocks.discardedDeleteMany.mockResolvedValue({ count: 4 });
  mocks.retryDiscardedItem.mockResolvedValue({ kind: 'created', articleId: 'article-1' });
  mocks.transaction.mockImplementation(async (input: unknown) => {
    if (typeof input === 'function') {
      return input({
        keyword: { deleteMany: mocks.keywordDeleteMany },
        keywordCandidate: { delete: mocks.candidateDelete },
      });
    }
    return Promise.all(input as Array<Promise<unknown>>);
  });
});

describe('关键词候选状态与过滤结论', () => {
  it('采用候选词后即时恢复近期记录，并清除剩余 filter:* 结论', async () => {
    mocks.candidateFindUnique.mockResolvedValue({ id: 'candidate-1', phrase: '奈雪', status: 'pending' });
    mocks.discardedFindMany.mockResolvedValue([{ id: 'discarded-1' }]);

    const result = await updateKeywordCandidate('candidate-1', 'approve');

    expect(result).toMatchObject({ restored: 1, articleIds: ['article-1'] });
    expect(mocks.invalidateKeywordCache).toHaveBeenCalledTimes(1);
    expect(mocks.discardedDeleteMany).toHaveBeenCalledWith({
      where: { reason: { startsWith: 'filter:' } },
    });
  });

  it('删除已采用候选词后也清除 filter:* 结论，避免按已删除关键词继续过滤', async () => {
    mocks.candidateFindUnique.mockResolvedValue({ id: 'candidate-1', phrase: '奈雪', status: 'approved' });

    await deleteKeywordCandidate('candidate-1');

    expect(mocks.keywordDeleteMany).toHaveBeenCalledWith({
      where: { category: '提取', word: '奈雪' },
    });
    expect(mocks.invalidateKeywordCache).toHaveBeenCalledTimes(1);
    expect(mocks.discardedDeleteMany).toHaveBeenCalledWith({
      where: { reason: { startsWith: 'filter:' } },
    });
  });
});
