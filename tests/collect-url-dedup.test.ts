/**
 * URL 去重回归：数据源标题/日期更新不能重置已处理文章的后续流水线状态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '@prisma/client';
import type { CrawlItem } from '@/contracts/crawl';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  articleCreate: vi.fn(),
  discardedItemFindFirst: vi.fn(),
  keywordMatch: vi.fn(),
  recordDiscarded: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findUnique: mocks.articleFindUnique,
      update: mocks.articleUpdate,
      create: mocks.articleCreate,
    },
    discardedItem: {
      findFirst: mocks.discardedItemFindFirst,
    },
  },
}));

vi.mock('@/lib/filter', () => ({ evaluateKeywordMatch: mocks.keywordMatch }));
vi.mock('@/lib/pipeline/discarded-items', () => ({ recordDiscardedItem: mocks.recordDiscarded }));

import { collectItem } from '@/lib/pipeline/collect';

function existingArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'article-1',
    url: 'https://example.com/news/1',
    title: '旧标题',
    publishedAt: new Date('2026-07-20T00:00:00.000Z'),
    ...overrides,
  } as Article;
}

describe('collectItem URL 去重', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleUpdate.mockResolvedValue({});
  });

  it('同 URL 的标题变化仅更新元数据，不重置详情、AI 或聚类状态', async () => {
    const item: CrawlItem = {
      url: 'https://example.com/news/1',
      title: '新标题',
    };

    await expect(collectItem('source-1', item, existingArticle())).resolves.toBe('existing');

    expect(mocks.articleCreate).not.toHaveBeenCalled();
    expect(mocks.articleUpdate).toHaveBeenCalledWith({
      where: { id: 'article-1' },
      data: { title: '新标题' },
    });

    const updateData = mocks.articleUpdate.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('fetchStatus');
    expect(updateData).not.toHaveProperty('aiStatus');
    expect(updateData).not.toHaveProperty('clusterStatus');
    expect(updateData).not.toHaveProperty('event');
  });

  it('同 URL 且元数据未变化时不产生数据库写入', async () => {
    const article = existingArticle();
    const item: CrawlItem = { url: article.url, title: article.title };

    await expect(collectItem('source-1', item, article)).resolves.toBe('existing');

    expect(mocks.articleUpdate).not.toHaveBeenCalled();
    expect(mocks.articleCreate).not.toHaveBeenCalled();
  });

  it('列表只有日期时不能覆盖已抓取文章的精确时间', async () => {
    const article = existingArticle({ fetchStatus: 'fetched', publishedAt: new Date('2026-07-20T10:35:00+08:00') });
    await collectItem('source-1', {
      url: article.url, title: article.title, publishedAt: '2026-07-20',
    }, article);
    expect(mocks.articleUpdate).not.toHaveBeenCalled();
  });

  it('尚未抓取的文章仍可以补充列表时间', async () => {
    const article = existingArticle({ fetchStatus: 'pending', publishedAt: null });
    await collectItem('source-1', {
      url: article.url, title: article.title, publishedAt: '2026-07-20',
    }, article);
    expect(mocks.articleUpdate).toHaveBeenCalledWith({
      where: { id: article.id }, data: { publishedAt: new Date('2026-07-20') },
    });
  });
});


describe('collectItem 迟到查询', () => {
  it.each([false, true])('关键词查询返回后取消，黑名单=%s 时不得落库', async (blacklisted) => {
    vi.clearAllMocks();
    const controller = new AbortController();
    mocks.keywordMatch.mockImplementationOnce(async () => {
      controller.abort(new Error('collection cancelled'));
      return { blacklisted };
    });
    await expect(collectItem('source-1', {
      url: 'https://example.com/late', title: '合成文章测试标题足够长',
    }, null, false, controller.signal)).rejects.toThrow('collection cancelled');
    expect(mocks.articleCreate).not.toHaveBeenCalled();
    expect(mocks.recordDiscarded).not.toHaveBeenCalled();
  });
});
