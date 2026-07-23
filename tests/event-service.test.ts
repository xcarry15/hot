import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindFirst: vi.fn(),
  articleFindUnique: vi.fn(),
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  articleUpdateMany: vi.fn(),
  articleUpdate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventDelete: vi.fn(),
  auditCreate: vi.fn(),
  auditDeleteMany: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  eventDirtyCreate: vi.fn(),
  eventDirtyCreateMany: vi.fn(),
  transaction: vi.fn(),
  refresh: vi.fn(),
}));

function transactionClient() {
  return {
    article: {
      findUnique: mocks.articleFindUnique,
      findFirst: mocks.articleFindFirst,
      findMany: mocks.articleFindMany,
      count: mocks.articleCount,
      update: mocks.articleUpdate,
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
    eventDirty: { create: mocks.eventDirtyCreate, createMany: mocks.eventDirtyCreateMany },
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    ...transactionClient(),
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/public-publication-service', () => ({ refreshEventPublicPublication: mocks.refresh }));

import { deriveEventClusterReviewStatus, mergeEvents, moveArticleToEvent, reconcileEventAfterArticleDeletion, selectRepresentativeCandidate, setEventRepresentative, sharedBrands, splitEventArticles } from '@/lib/event-service';

describe('Event 人工纠错', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFindUnique.mockReset();
    mocks.articleFindMany.mockReset();
    mocks.articleFindUnique.mockReset();
    mocks.transaction.mockImplementation((operation: (client: ReturnType<typeof transactionClient>) => unknown) => operation(transactionClient()));
    mocks.auditCreate.mockResolvedValue({});
    mocks.articleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.articleUpdate.mockResolvedValue({});
    mocks.eventUpdate.mockResolvedValue({});
    mocks.eventUpdateMany.mockResolvedValue({ count: 0 });
    mocks.eventDelete.mockResolvedValue({});
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.pushLogDeleteMany.mockResolvedValue({ count: 2 });
    mocks.refresh.mockResolvedValue(true);
  });

  it('Event 只要仍有待复核成员就保持 pending', () => {
    expect(deriveEventClusterReviewStatus(['clustered', 'needs_review'])).toBe('pending');
    expect(deriveEventClusterReviewStatus(['clustered', 'clustered'])).toBe('confirmed');
  });

  it('同品牌候选按规范化品牌数组做精确交集，不误命中品牌片段', () => {
    expect(sharedBrands('["肯德基"]', '["肯德基", "麦当劳"]')).toEqual(['肯德基']);
    expect(sharedBrands('["肯德基"]', '["肯德基中国"]')).toEqual([]);
    expect(sharedBrands('瑞幸咖啡，塔斯汀', '["塔斯汀"]')).toEqual(['塔斯汀']);
  });

  it('合并已推送来源 Event 时不再继承推送状态', async () => {
    const pushedAt = new Date('2026-07-18T00:00:00Z');
    mocks.eventFindUnique
      .mockResolvedValueOnce({ id: 'source', status: 'active', pushedAt, articles: [{ id: 'a1' }] })
      .mockResolvedValueOnce({ id: 'target', status: 'active', pushedAt: null })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ firstSeenAt: pushedAt, lastSeenAt: pushedAt })
      .mockResolvedValueOnce({ representativeArticleId: 'a1' })
      .mockResolvedValueOnce({ representativeArticleId: 'a1' });
    mocks.articleFindMany
      .mockResolvedValueOnce([{ id: 'a1', publishedAt: pushedAt, createdAt: pushedAt }])
      .mockResolvedValueOnce([{ id: 'a1', clusterStatus: 'clustered', aiStatus: 'done', reviewStatus: 'important', score: 90, relevance: 90, cleanContent: '正文', publishedAt: pushedAt, createdAt: pushedAt, source: { publicEnabled: true, deletedAt: null } }]);
    await expect(mergeEvents('source', 'target')).resolves.toBe(true);
    // P0-5: 不再复制 pushedAt
    expect(mocks.eventUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pushedAt: expect.anything() }) }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: 'admin', action: 'merge', assignedEventId: 'target' }),
    }));
  });

  it('自动代表文章优先选择可发布成员而不是待复核高分成员', () => {
    const now = new Date();
    const selected = selectRepresentativeCandidate([
      { id: 'review', clusterStatus: 'needs_review', aiStatus: 'done', reviewStatus: 'important', score: 100, relevance: 100, cleanContent: '更长正文', publishedAt: now, createdAt: now, source: { publicEnabled: true, deletedAt: null } },
      { id: 'ready', clusterStatus: 'clustered', aiStatus: 'done', reviewStatus: 'general', score: 60, relevance: 60, cleanContent: '正文', publishedAt: now, createdAt: now, source: { publicEnabled: true, deletedAt: null } },
    ]);
    expect(selected).toBe('ready');
  });

  it('从已推送 Event 拆分时新 Event 保持未推送', async () => {
    const articleDate = new Date('2026-07-17T00:00:00Z');
    mocks.eventFindUnique
      .mockResolvedValueOnce({ status: 'active' })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ representativeArticleId: 'remaining' })
      .mockResolvedValueOnce({ representativeArticleId: 'split' })
      .mockResolvedValueOnce({ representativeArticleId: 'split' });
    mocks.articleFindMany
      .mockResolvedValueOnce([{ id: 'split', publishedAt: articleDate, createdAt: articleDate }])
      .mockResolvedValueOnce([{ id: 'remaining', publishedAt: articleDate, createdAt: articleDate }])
      .mockResolvedValueOnce([{ id: 'remaining', clusterStatus: 'clustered', aiStatus: 'done', reviewStatus: 'general', score: 50, relevance: 50, cleanContent: '正文', publishedAt: articleDate, createdAt: articleDate, source: { publicEnabled: true, deletedAt: null } }])
      .mockResolvedValueOnce([{ id: 'split', publishedAt: articleDate, createdAt: articleDate }])
      .mockResolvedValueOnce([{ id: 'split', clusterStatus: 'clustered', aiStatus: 'done', reviewStatus: 'general', score: 50, relevance: 50, cleanContent: '正文', publishedAt: articleDate, createdAt: articleDate, source: { publicEnabled: true, deletedAt: null } }]);
    mocks.articleCount.mockResolvedValue(2);
    mocks.eventCreate.mockResolvedValue({ id: 'new-event' });
    await expect(splitEventArticles('source', ['split'])).resolves.toBe('new-event');
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ pushedAt: expect.anything() }),
    }));
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ representativeArticleId: null }),
    }));
    expect(mocks.refresh).toHaveBeenCalledWith('source');
    expect(mocks.refresh).toHaveBeenCalledWith('new-event');
  });

  it('删除最后一篇 Article 后归档空 Event 并保留投递审计', async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ id: 'e1' });
    mocks.articleCount.mockResolvedValue(0);
    await expect(reconcileEventAfterArticleDeletion('e1')).resolves.toEqual({ pushLogsDeleted: 0 });
    expect(mocks.pushLogDeleteMany).not.toHaveBeenCalled();
    expect(mocks.eventDelete).not.toHaveBeenCalled();
    expect(mocks.eventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'e1' },
      data: expect.objectContaining({ status: 'merged', articleCount: 0, publicStatus: 'revoked' }),
    }));
  });

  it('已合并 Event 不能继续拆分', async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ status: 'merged', pushedAt: null });
    await expect(splitEventArticles('merged', ['a1'])).resolves.toBeNull();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it('待复核文章不能被人工设为代表文章', async () => {
    mocks.eventFindUnique.mockResolvedValueOnce({ status: 'active' });
    mocks.articleFindFirst.mockResolvedValueOnce({
      id: 'a1', clusterStatus: 'needs_review', aiStatus: 'done', reviewStatus: 'important',
      score: 100, relevance: 100, cleanContent: '正文', publishedAt: null, createdAt: new Date(),
      source: { publicEnabled: true, deletedAt: null },
    });
    await expect(setEventRepresentative('e1', 'a1')).resolves.toBe(false);
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });

  it('移动文章到已有 Event 时保留 Article 自身事件身份', async () => {
    mocks.articleFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.articleFindFirst.mockResolvedValue(null);
    mocks.eventFindUnique
      .mockResolvedValueOnce({
        id: 'target',
        status: 'active',
      })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false })
      .mockResolvedValueOnce({ representativeArticleId: null, representativeManual: false });
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a1', eventId: 'source', aiStatus: 'done', clusterStatus: 'needs_review',
      eventSubjects: '["旧品牌"]', eventAction: '开店', eventObject: '旧事项',
      eventKey: '旧品牌/开店/旧事项', eventKeyConfidence: 60,
    });

    await expect(moveArticleToEvent('a1', 'target')).resolves.toBe(true);
    expect(mocks.articleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' },
      data: expect.objectContaining({
        eventId: 'target',
        clusterStatus: 'clustered',
      }),
    }));
    const moveUpdate = mocks.articleUpdate.mock.calls.find(([input]) => input?.where?.id === 'a1')?.[0];
    expect(moveUpdate?.data).not.toHaveProperty('eventSubjects');
    expect(moveUpdate?.data).not.toHaveProperty('eventAction');
    expect(moveUpdate?.data).not.toHaveProperty('eventObject');
    expect(moveUpdate?.data).not.toHaveProperty('eventKey');
  });
});
