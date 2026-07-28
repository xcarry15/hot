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

    await collectItem('source-1', '示例来源', item, existingArticle());

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

    await collectItem('source-1', '示例来源', item, article);

    expect(mocks.articleUpdate).not.toHaveBeenCalled();
    expect(mocks.articleCreate).not.toHaveBeenCalled();
  });
});
