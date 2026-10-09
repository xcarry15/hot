import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { persistArticleKeywordMatch } from '@/lib/keyword-hit-service';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.$transaction).mockImplementation(async (operation) => (
    typeof operation === 'function' ? operation(db as Prisma.TransactionClient) : Promise.all(operation)
  ));
  vi.mocked(db.article.update).mockResolvedValue({} as never);
  vi.mocked(db.keywordHit.deleteMany).mockResolvedValue({ count: 1 });
  vi.mocked(db.keyword.findMany).mockResolvedValue([{ id: 'k1' }] as never);
  vi.mocked(db.keywordHit.createMany).mockResolvedValue({ count: 1 });
});

describe('关键词写入的事务取消检查', () => {
  it('等到事务开始时已经取消，不再执行写入', async () => {
    const controller = new AbortController();
    vi.mocked(db.$transaction).mockImplementationOnce(async (operation) => {
      controller.abort(new Error('Stopped by user'));
      if (typeof operation !== 'function') throw new Error('Expected interactive transaction');
      return operation(db as Prisma.TransactionClient);
    });
    await expect(persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['品牌'] }, controller.signal))
      .rejects.toThrow('Stopped by user');
    expect(db.article.update).not.toHaveBeenCalled();
    expect(db.keywordHit.deleteMany).not.toHaveBeenCalled();
  });

  it('明细写入期间取消，事务回调必须抛错以触发回滚', async () => {
    const controller = new AbortController();
    vi.mocked(db.keywordHit.createMany).mockImplementationOnce(() => {
      controller.abort(new Error('Stopped by user'));
      return Promise.resolve({ count: 1 }) as ReturnType<typeof db.keywordHit.createMany>;
    });
    await expect(persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['品牌'] }, controller.signal))
      .rejects.toThrow('Stopped by user');
    expect(db.article.update).toHaveBeenCalledOnce();
    expect(db.keywordHit.createMany).toHaveBeenCalledOnce();
  });
});
