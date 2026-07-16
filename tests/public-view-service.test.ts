import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { enqueuePublicArticleView, flushPublicArticleViews } from '@/lib/public-view-service';

const mocks = db as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>;
};

describe('public-view-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.$executeRaw.mockResolvedValue(1);
    await flushPublicArticleViews();
  });

  it('聚合浏览量后使用原生 SQL 写入，不触发 Prisma updatedAt', async () => {
    enqueuePublicArticleView('a1');
    enqueuePublicArticleView('a1');
    await flushPublicArticleViews();

    expect(mocks.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
