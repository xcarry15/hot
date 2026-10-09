import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventRevisionFindMany: vi.fn(),
  transaction: vi.fn(),
  eventGroupBy: vi.fn(),
  eventCount: vi.fn(),
  eventFindFirst: vi.fn(),
  articleFindMany: vi.fn(),
  articleFindUnique: vi.fn(),
}));

const interactionMocks = vi.hoisted(() => ({
  recordView: vi.fn(),
  recordOriginalClick: vi.fn(),
}));

vi.mock('@/lib/db', () => {
  const findMany = (args: { select?: { publicSortAt?: boolean; representativeArticle?: { select?: { title?: boolean } } } }) => (
    args.select?.publicSortAt && !args.select.representativeArticle?.select?.title
      ? mocks.eventRevisionFindMany(args)
      : mocks.eventFindMany(args)
  );
  const event = { findMany, findFirst: mocks.eventFindFirst, count: mocks.eventCount, groupBy: mocks.eventGroupBy };
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({ event }));
  return { db: {
    event,
    $transaction: mocks.transaction,
    article: { findMany: mocks.articleFindMany, findUnique: mocks.articleFindUnique },
  } };
});
vi.mock('@/lib/public-view-service', () => ({
  recordPublicEventView: interactionMocks.recordView,
  recordPublicEventOriginalClick: interactionMocks.recordOriginalClick,
}));

import { getPublicArticleFeedRevision, getPublicArticleDetail, listPublicArticleIds, listPublicArticles, recordOriginalClick } from '@/lib/public-article-service';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';

function eventRow(id: string, publishedAt: string, sourceCount = 1) {
  return {
    id,
    publicDateKey: '2026-07-15',
    firstSeenAt: new Date(publishedAt),
    lastSeenAt: new Date(publishedAt),
    articleCount: sourceCount,
    representativeArticle: {
      id: `article-${id}`,
      url: `https://example.com/${id}`,
      title: `文章 ${id}`,
      originalSource: null,
      cleanContent: '正文',
      summary: `摘要 ${id}`,
      brand: '品牌A',
      category: '行业',
      keyPoints: '[]',
      score: 82,
      publishedAt: new Date(publishedAt),
      createdAt: new Date(publishedAt),
      publicContentUpdatedAt: new Date(publishedAt),
      eventId: id,
      source: { id: 's1', name: '数据源A', type: 'html' },
    },
  };
}

describe('public-article-service Event 门禁', () => {
  it('失效前的旧列表请求迟到失败，不能清掉失效后重建的缓存', async () => {
    let rejectOld!: (error: Error) => void;
    mocks.transaction.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const pending = listPublicArticles();
    const rejected = expect(pending).rejects.toThrow('late failure');
    invalidatePublicArticleCache();
    const fresh = await listPublicArticles();

    rejectOld(new Error('late failure'));
    await rejected;
    await expect(listPublicArticles()).resolves.toBe(fresh);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePublicArticleCache();
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.eventRevisionFindMany.mockResolvedValue([]);
    mocks.eventGroupBy.mockResolvedValue([]);
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.eventCount.mockResolvedValue(0);
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.articleFindUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({
      id: where.id,
      title: `文章 ${where.id}`,
      summary: `摘要 ${where.id}`,
      brand: '品牌A',
      score: 82,
      createdAt: new Date('2026-07-15T01:00:00Z'),
      publishedAt: new Date('2026-07-15T01:00:00Z'),
      aiStatus: 'done',
      eventId: 'e1',
    }));
    interactionMocks.recordView.mockResolvedValue(undefined);
    interactionMocks.recordOriginalClick.mockResolvedValue(undefined);
  });

  it('一个 Event 只输出一张卡片并携带来源数', async () => {
    mocks.eventGroupBy.mockResolvedValueOnce([{ publicDateKey: '2026-07-15' }]);
    mocks.eventFindMany.mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 3)]);
    mocks.eventCount.mockResolvedValue(1);
    const result = await listPublicArticles();
    expect(result.groups.flatMap((group) => group.items)).toHaveLength(1);
    expect(result.groups[0].items[0]).toMatchObject({ id: 'e1', sourceCount: 3, title: '文章 e1' });
  });

  it('首屏内容与修订指纹在同一事务内读取', async () => {
    mocks.eventFindMany.mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z')]);
    mocks.eventRevisionFindMany.mockResolvedValueOnce([{ id: 'e1', representativeArticleId: 'a1' }]);
    const result = await listPublicArticles();
    expect(result.total).toBe(1);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('详情使用 Event.id，并列出同事件与同品牌的近期文章', async () => {
    const recentArticleDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mocks.eventFindMany
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)])
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)]);
    mocks.articleFindMany.mockResolvedValue([
      { id: 'a1', eventId: 'e1', title: '来源一', summary: '', brand: '', score: 70, aiStatus: 'done', url: 'https://example.com/a1', publishedAt: null, createdAt: recentArticleDate, source: { name: '源一', type: 'html' }, event: { id: 'e1', firstSeenAt: recentArticleDate }, representedEvent: null },
      { id: 'a2', eventId: 'e2', title: '品牌文章', summary: '', brand: '品牌A', score: 75, aiStatus: 'done', url: 'https://example.com/a2', publishedAt: null, createdAt: new Date(recentArticleDate.getTime() + 60 * 60 * 1000), source: { name: '源二', type: 'rss' }, event: null, representedEvent: { id: 'e2', firstSeenAt: new Date(recentArticleDate.getTime() + 60 * 60 * 1000) } },
    ]);
    const detail = await getPublicArticleDetail('e1');
    expect(detail?.id).toBe('e1');
    expect(detail?.recentArticles).toHaveLength(2);
    expect(detail?.recentArticles.map(({ relation }) => relation)).toEqual(['same_brand', 'same_event']);
  });

  it('详情命中缓存时仍重新检查当前公开资格', async () => {
    mocks.eventFindMany
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)])
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)]);

    await expect(getPublicArticleDetail('e1')).resolves.toMatchObject({ id: 'e1' });
    mocks.eventFindFirst.mockResolvedValueOnce(null);

    await expect(getPublicArticleDetail('e1')).resolves.toBeNull();
    expect(mocks.eventFindFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'e1', publicStatus: 'published' }),
      select: { id: true },
    });
    expect(mocks.eventFindMany).toHaveBeenCalledTimes(2);
  });

  it('sitemap 使用 Event.id 和代表文章内容更新时间', async () => {
    mocks.eventFindMany.mockResolvedValue([eventRow('e1', '2026-07-15T01:00:00Z')]);
    await expect(listPublicArticleIds()).resolves.toEqual([{ id: 'e1', updatedAt: new Date('2026-07-15T01:00:00Z') }]);
  });

  it('原文点击按 Event 与当前代表来源入账', async () => {
    mocks.eventFindFirst.mockResolvedValue({ id: 'e1', representativeArticle: { sourceId: 's1' } });
    await expect(recordOriginalClick('e1')).resolves.toBe(true);
    expect(interactionMocks.recordOriginalClick).toHaveBeenCalledWith('e1', 's1');
  });
});


describe('公开资讯修订探针', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePublicArticleCache();
    mocks.eventRevisionFindMany.mockResolvedValue([]);
  });

  it('总数不变时，旧文章修订、代表切换和成员替换仍改变指纹', async () => {
    const initial = { id: 'e1', articleCount: 1, representativeArticleId: 'a1', representativeArticle: { publicContentUpdatedAt: new Date('2026-10-01') } };
    mocks.eventRevisionFindMany.mockResolvedValue([initial]);
    const before = await getPublicArticleFeedRevision();
    for (const changed of [
      { ...initial, representativeArticle: { publicContentUpdatedAt: new Date('2026-10-02') } },
      { ...initial, representativeArticleId: 'a2' },
      { ...initial, id: 'e2' },
    ]) {
      invalidatePublicArticleCache();
      mocks.eventRevisionFindMany.mockResolvedValue([changed]);
      const after = await getPublicArticleFeedRevision();
      expect(after.total).toBe(before.total);
      expect(after.revision).not.toBe(before.revision);
    }
  });

  it('并发探针共享请求，公开变更后失效，并限制投影和批次', async () => {
    await Promise.all([getPublicArticleFeedRevision(), getPublicArticleFeedRevision()]);
    expect(mocks.eventRevisionFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.eventRevisionFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    const query = mocks.eventRevisionFindMany.mock.calls[0][0];
    expect(query.select.representativeArticle.select).not.toHaveProperty('cleanContent');
    invalidatePublicArticleCache();
    await getPublicArticleFeedRevision();
    expect(mocks.eventRevisionFindMany).toHaveBeenCalledTimes(2);
  });
});
