import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventGroupBy: vi.fn(),
  eventCount: vi.fn(),
  eventFindFirst: vi.fn(),
  articleFindMany: vi.fn(),
  articleFindUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    event: { findMany: mocks.eventFindMany, findFirst: mocks.eventFindFirst, count: mocks.eventCount, groupBy: mocks.eventGroupBy },
    article: { findMany: mocks.articleFindMany, findUnique: mocks.articleFindUnique },
  },
}));

import { getPublicArticleDetail, listPublicArticleIds, listPublicArticles, recordOriginalClick } from '@/lib/public-article-service';
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
      pinUntil: null,
      publishedAt: new Date(publishedAt),
      createdAt: new Date(publishedAt),
      publicContentUpdatedAt: new Date(publishedAt),
      eventId: id,
      source: { id: 's1', name: '数据源A', type: 'html' },
    },
  };
}

describe('public-article-service Event 门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePublicArticleCache();
    mocks.eventFindMany.mockResolvedValue([]);
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
  });

  it('一个 Event 只输出一张卡片并携带来源数', async () => {
    mocks.eventGroupBy.mockResolvedValueOnce([{ publicDateKey: '2026-07-15' }]);
    mocks.eventFindMany.mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 3)]);
    mocks.eventCount.mockResolvedValue(1);
    const result = await listPublicArticles();
    expect(result.groups.flatMap((group) => group.items)).toHaveLength(1);
    expect(result.groups[0].items[0]).toMatchObject({ id: 'e1', sourceCount: 3, title: '文章 e1' });
  });

  it('详情使用 Event.id，并列出同事件与同品牌的近期文章', async () => {
    mocks.eventFindMany
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)])
      .mockResolvedValueOnce([eventRow('e1', '2026-07-15T01:00:00Z', 2)]);
    mocks.articleFindMany.mockResolvedValue([
      { id: 'a1', eventId: 'e1', title: '来源一', summary: '', brand: '', score: 70, aiStatus: 'done', url: 'https://example.com/a1', publishedAt: null, createdAt: new Date('2026-07-15T01:00:00Z'), source: { name: '源一', type: 'html' }, event: { id: 'e1', firstSeenAt: new Date('2026-07-15T01:00:00Z') }, representedEvent: null },
      { id: 'a2', eventId: 'e2', title: '品牌文章', summary: '', brand: '品牌A', score: 75, aiStatus: 'done', url: 'https://example.com/a2', publishedAt: null, createdAt: new Date('2026-07-15T02:00:00Z'), source: { name: '源二', type: 'rss' }, event: null, representedEvent: { id: 'e2', firstSeenAt: new Date('2026-07-15T02:00:00Z') } },
    ]);
    const detail = await getPublicArticleDetail('e1');
    expect(detail?.id).toBe('e1');
    expect(detail?.recentArticles).toHaveLength(2);
    expect(detail?.recentArticles.map(({ relation }) => relation)).toEqual(['same_brand', 'same_event']);
  });

  it('sitemap 使用 Event.id 和代表文章内容更新时间', async () => {
    mocks.eventFindMany.mockResolvedValue([eventRow('e1', '2026-07-15T01:00:00Z')]);
    await expect(listPublicArticleIds()).resolves.toEqual([{ id: 'e1', updatedAt: new Date('2026-07-15T01:00:00Z') }]);
  });

  it('原文点击通过 Event 找到代表 Article', async () => {
    mocks.eventFindFirst.mockResolvedValue({ representativeArticleId: 'a1' });
    await expect(recordOriginalClick('e1')).resolves.toBe(true);
  });
});
