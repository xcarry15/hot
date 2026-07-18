import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindFirst: vi.fn(),
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  articleUpdateMany: vi.fn(),
  eventFindUnique: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventDelete: vi.fn(),
  auditCreate: vi.fn(),
  auditDeleteMany: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  transaction: vi.fn(),
  refresh: vi.fn(),
}));

function transactionClient() {
  return {
    article: {
      findFirst: mocks.articleFindFirst,
      findMany: mocks.articleFindMany,
      count: mocks.articleCount,
      updateMany: mocks.articleUpdateMany,
    },
    event: {
      findUnique: mocks.eventFindUnique,
      create: mocks.eventCreate,
      update: mocks.eventUpdate,
      updateMany: mocks.eventUpdateMany,
      delete: mocks.eventDelete,
    },
    eventClusterAudit: { create: mocks.auditCreate, deleteMany: mocks.auditDeleteMany },
    pushLog: { deleteMany: mocks.pushLogDeleteMany },
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    ...transactionClient(),
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/public-publication-service', () => ({ refreshPublicPublication: mocks.refresh }));

import { mergeEvents, reconcileEventAfterArticleDeletion, splitEventArticles } from '@/lib/event-service';

describe('Event 人工纠错', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFindUnique.mockReset();
    mocks.articleFindMany.mockReset();
    mocks.transaction.mockImplementation((operation: (client: ReturnType<typeof transactionClient>) => unknown) => operation(transactionClient()));
    mocks.auditCreate.mockResolvedValue({});
    mocks.articleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.eventUpdate.mockResolvedValue({});
    mocks.eventUpdateMany.mockResolvedValue({ count: 0 });
    mocks.eventDelete.mockResolvedValue({});
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.pushLogDeleteMany.mockResolvedValue({ count: 2 });
    mocks.refresh.mockResolvedValue(true);
  });

  it('合并已推送来源 Event 时继承推送状态且不补推', async () => {
    const pushedAt = new Date('2026-07-18T00:00:00Z');
    mocks.eventFindUnique
      .mockResolvedValueOnce({ id: 'source', status: 'active', pushedAt, articles: [{ id: 'a1' }] })
      .mockResolvedValueOnce({ id: 'target', status: 'active', pushedAt: null })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ firstSeenAt: pushedAt, lastSeenAt: pushedAt })
      .mockResolvedValueOnce({ representativeArticleId: 'a1' });
    mocks.articleFindMany
      .mockResolvedValueOnce([{ id: 'a1', publishedAt: pushedAt, createdAt: pushedAt }])
      .mockResolvedValueOnce([{ id: 'a1', reviewStatus: 'important', score: 90, relevance: 90, cleanContent: '正文', publishedAt: pushedAt, createdAt: pushedAt }]);
    await expect(mergeEvents('source', 'target')).resolves.toBe(true);
    expect(mocks.eventUpdate).toHaveBeenCalledWith({ where: { id: 'target' }, data: { pushedAt } });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: 'admin', action: 'merge', assignedEventId: 'target' }),
    }));
  });

  it('从已推送 Event 拆分时新 Event 继承 pushedAt', async () => {
    const pushedAt = new Date('2026-07-18T00:00:00Z');
    const articleDate = new Date('2026-07-17T00:00:00Z');
    mocks.eventFindUnique
      .mockResolvedValueOnce({ status: 'active', pushedAt })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ representativeArticleId: 'remaining' })
      .mockResolvedValueOnce({ representativeArticleId: 'split' });
    mocks.articleFindMany
      .mockResolvedValueOnce([{ id: 'split', publishedAt: articleDate, createdAt: articleDate }])
      .mockResolvedValueOnce([{ id: 'remaining', publishedAt: articleDate, createdAt: articleDate }])
      .mockResolvedValueOnce([{ id: 'remaining', reviewStatus: 'general', score: 50, relevance: 50, cleanContent: '正文', publishedAt: articleDate, createdAt: articleDate }]);
    mocks.articleCount.mockResolvedValue(2);
    mocks.eventCreate.mockResolvedValue({ id: 'new-event' });
    await expect(splitEventArticles('source', ['split'])).resolves.toBe('new-event');
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pushedAt, representativeArticleId: 'split' }),
    }));
    expect(mocks.refresh).toHaveBeenCalledWith('remaining');
    expect(mocks.refresh).toHaveBeenCalledWith('split');
  });

  it('删除最后一篇 Article 后清理空 Event 及关联记录', async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ id: 'e1' });
    mocks.articleCount.mockResolvedValue(0);
    await expect(reconcileEventAfterArticleDeletion('e1')).resolves.toEqual({ pushLogsDeleted: 2 });
    expect(mocks.auditDeleteMany).toHaveBeenCalledWith({
      where: { OR: [{ assignedEventId: 'e1' }, { candidateEventId: 'e1' }] },
    });
    expect(mocks.eventDelete).toHaveBeenCalledWith({ where: { id: 'e1' } });
  });

  it('已合并 Event 不能继续拆分', async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ status: 'merged', pushedAt: null });
    await expect(splitEventArticles('merged', ['a1'])).resolves.toBeNull();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});
