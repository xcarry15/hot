import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { enqueuePublicArticleOriginalClick, enqueuePublicArticleView, flushPublicArticleViews } from '@/lib/public-view-service';

const mocks = db as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
};

describe('public-view-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.$executeRaw.mockResolvedValue(1);
    mocks.$transaction.mockImplementation(async (writes: Array<Promise<unknown>>) => Promise.all(writes));
    await flushPublicArticleViews();
  });

  it('聚合浏览量后使用原生 SQL 写入，不触发 Prisma updatedAt', async () => {
    enqueuePublicArticleView('a1');
    enqueuePublicArticleView('a1');
    await flushPublicArticleViews();

    expect(mocks.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('浏览和原文点击合并到同一个短事务', async () => {
    enqueuePublicArticleView('a1');
    enqueuePublicArticleOriginalClick('a1');
    await flushPublicArticleViews();

    expect(mocks.$executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
  });
});
