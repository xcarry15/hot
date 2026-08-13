import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleUpdateMany: vi.fn(),
  keywordHitDeleteMany: vi.fn(),
  transaction: vi.fn(),
  resetArticleAiAndEventState: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: { findMany: mocks.articleFindMany, updateMany: mocks.articleUpdateMany },
    keywordHit: { deleteMany: mocks.keywordHitDeleteMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/maintenance-service', () => ({
  AI_RESET_ARTICLE_SELECT: { id: true },
  resetArticleAiAndEventState: mocks.resetArticleAiAndEventState,
}));

import { normalizeAiRecoveryBacklog } from '@/lib/pipeline/ai-recovery';

describe('AI 批量恢复状态归一化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (operation: (tx: object) => Promise<void>) => operation({
      article: { updateMany: mocks.articleUpdateMany },
      keywordHit: { deleteMany: mocks.keywordHitDeleteMany },
    }));
    mocks.resetArticleAiAndEventState.mockResolvedValue(undefined);
    mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
    mocks.keywordHitDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('人工全流程恢复 waiting、failed 和达到上限的技术失败', async () => {
    const articles = [{ id: 'waiting' }, { id: 'failed' }, { id: 'skipped' }];
    mocks.articleFindMany.mockResolvedValueOnce(articles).mockResolvedValueOnce([]);

    await expect(normalizeAiRecoveryBacklog(true)).resolves.toBe(3);

    expect(mocks.articleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fetchStatus: 'fetched',
        technicalIgnoredAt: null,
        OR: expect.arrayContaining([
          { aiStatus: 'failed' },
          { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
        ]),
      }),
    }));
    expect(mocks.resetArticleAiAndEventState).toHaveBeenCalledWith(expect.any(Object), articles);
    expect(mocks.articleUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['waiting', 'failed', 'skipped'] } },
      data: expect.objectContaining({
        fetchStatus: 'pending',
        fetchRetryCount: 0,
        nextFetchRetryAt: null,
      }),
    });
  });

  it('自动恢复只修正已到期且带 Event 或聚类残留的异常组合', async () => {
    const now = new Date('2026-08-13T00:00:00Z');
    mocks.articleFindMany.mockResolvedValueOnce([]);

    await normalizeAiRecoveryBacklog(false, now);

    expect(mocks.articleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({ OR: expect.arrayContaining([{ eventId: { not: null } }]) }),
          expect.objectContaining({
            OR: expect.arrayContaining([
              { aiStatus: 'pending', nextAiRetryAt: { lte: now } },
            ]),
          }),
        ]),
      }),
    }));
  });
});
