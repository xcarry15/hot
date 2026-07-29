/**
 * processAllPending 阶段集成测试
 *
 * 覆盖:
 * - 全文关键字匹配：不命中 → 删除 + DiscardedItem
 * - 黑名单命中：删除 + DiscardedItem 写入 filter:blacklist
 * - 详情抓取失败：跳过关键字门控
 * - 关键字 DB 抛错：宁可放过不可误杀（fall through 到 processed++）
 *
 * 关键字匹配位于 process 阶段，以详情正文而非列表页摘要为准。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  // db.article
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  articleUpdate: vi.fn(),
  articleUpdateMany: vi.fn(),
  articleDelete: vi.fn(),
  articleFindUnique: vi.fn(),
  // db.discardedItem
  discardedItemUpsert: vi.fn(),
  // db.source
  sourceUpdate: vi.fn(),
  sourceFindUnique: vi.fn(),
  // db.keyword (matchKeyword)
  keywordFindMany: vi.fn(),
  keywordCandidateFindMany: vi.fn(),
  keywordCandidateUpsert: vi.fn(),
  transaction: vi.fn(),
  // detail-fetcher
  fetchArticleDetail: vi.fn(),
  markArticleFetchFailure: vi.fn(),
  // utils-shared
  withTimeout: vi.fn(),
  abortableDelay: vi.fn(),
  // worker-stop
  assertNotAborted: vi.fn(),
  refreshPublicPublication: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      count: mocks.articleCount,
      update: mocks.articleUpdate,
      updateMany: mocks.articleUpdateMany,
      delete: mocks.articleDelete,
      findUnique: mocks.articleFindUnique,
    },
    discardedItem: {
      upsert: mocks.discardedItemUpsert,
    },
    source: {
      update: mocks.sourceUpdate,
      findUnique: mocks.sourceFindUnique,
    },
    keyword: {
      findMany: mocks.keywordFindMany,
    },
    keywordCandidate: {
      findMany: mocks.keywordCandidateFindMany,
      upsert: mocks.keywordCandidateUpsert,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/detail-fetcher', () => ({
  fetchArticleDetail: mocks.fetchArticleDetail,
  markArticleFetchFailure: mocks.markArticleFetchFailure,
}));

// withTimeout：直接返回 promise，避免 fetch 阶段被卡死
vi.mock('@/lib/utils-shared', () => ({
  withTimeout: mocks.withTimeout,
  abortableDelay: mocks.abortableDelay,
}));

// worker-stop.assertNotAborted：no-op
vi.mock('@/lib/worker-stop', () => ({
  assertNotAborted: mocks.assertNotAborted,
}));

vi.mock('@/lib/public-publication-service', () => ({
  refreshPublicPublication: mocks.refreshPublicPublication,
}));

import { processAllPending, repairPublishedDates } from '../src/lib/pipeline/process';
import { invalidateKeywordCache } from '../src/lib/filter';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateKeywordCache();
  // 默认 withTimeout 直接透传
  mocks.withTimeout.mockImplementation((operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal));
  mocks.abortableDelay.mockResolvedValue(undefined);
  // 默认 fetchArticleDetail 返空（测试需要时再覆盖）
  mocks.fetchArticleDetail.mockResolvedValue('');
  mocks.markArticleFetchFailure.mockResolvedValue(true);
  // 默认 article.findMany（pending + repairPublishedDates）返空
  mocks.articleFindMany.mockResolvedValue([]);
  // 默认 article.update / updateMany / delete 返 {}
  mocks.articleUpdate.mockResolvedValue({});
  mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
  mocks.articleCount.mockResolvedValue(0);
  mocks.articleDelete.mockResolvedValue({});
  // 默认 discardedItem.upsert 返 {}
  mocks.discardedItemUpsert.mockResolvedValue({});
  // 默认 source 返空
  mocks.sourceUpdate.mockResolvedValue({});
  mocks.sourceFindUnique.mockResolvedValue(null);
  // 默认 keyword DB 空 → matchKeyword 返 true
  mocks.keywordFindMany.mockResolvedValue([]);
  mocks.keywordCandidateFindMany.mockResolvedValue([]);
  mocks.keywordCandidateUpsert.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (writes: Array<Promise<unknown>>) => Promise.all(writes));
});

// 触发 processAllPending 的最小数据：一条 pending article
function mockPendingArticle(overrides: Partial<{ id: string; title: string; url: string; sourceId: string }> = {}) {
  return {
    id: overrides.id ?? 'art-001',
    title: overrides.title ?? '奈雪发布2026战略',
    url: overrides.url ?? 'https://example.com/news/naixue-2026',
    sourceId: overrides.sourceId ?? 'src-001',
  };
}

describe('processAllPending 全文关键字匹配', () => {
  it('正文命中关键字 → 文章保留，processed++', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    // process stage 只处理 content.length > 50 的 article
    const longContent = '奈雪发布2026战略：计划新开300家门店聚焦一二线城市，进一步扩大品牌影响力'.repeat(2);
    mocks.fetchArticleDetail.mockResolvedValueOnce(longContent);
    mocks.keywordFindMany.mockResolvedValueOnce([{ word: '奈雪' }]);

    const result = await processAllPending();

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).not.toHaveBeenCalled();
    expect(mocks.discardedItemUpsert).not.toHaveBeenCalled();
    expect(mocks.articleUpdate).toHaveBeenCalledWith({
      where: { id: 'art-001' },
      data: { keywordMatched: true },
    });
  });

  it('正文不命中关键字 → 文章删除 + DiscardedItem 写入 filter:keyword', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    // 文章标题不含 '瑞幸'，正文也不含 → 关键字门控必须拒绝
    const longContent = '星巴克发布新品美式咖啡：新增冷萃系列与即饮产品，瞄准年轻消费群体'.repeat(2);
    mocks.fetchArticleDetail.mockResolvedValueOnce(longContent);
    mocks.keywordFindMany.mockResolvedValueOnce([{ word: '瑞幸' }]);

    const result = await processAllPending();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).toHaveBeenCalledTimes(1);
    expect(mocks.articleDelete).toHaveBeenCalledWith({ where: { id: 'art-001' } });
    expect(mocks.discardedItemUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mocks.discardedItemUpsert.mock.calls[0][0];
    expect(upsertArgs.create.reason).toBe('filter:keyword');
    expect(upsertArgs.create.title).toBe('奈雪发布2026战略');
  });

  it('正文命中黑名单 → 文章删除 + DiscardedItem 写入 filter:blacklist', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    const longContent = '该报道涉及赌博活动，属于黑名单内容，应在进入 AI 前拦截。'.repeat(2);
    mocks.fetchArticleDetail.mockResolvedValueOnce(longContent);
    mocks.keywordFindMany.mockResolvedValueOnce([
      { word: '奈雪', category: 'default' },
      { word: '赌博', category: '黑名单' },
    ]);

    const result = await processAllPending();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).toHaveBeenCalledWith({ where: { id: 'art-001' } });
    expect(mocks.discardedItemUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mocks.discardedItemUpsert.mock.calls[0][0];
    expect(upsertArgs.create.reason).toBe('filter:blacklist');
    expect(upsertArgs.create.detail).toContain('赌博');
  });

  it('白名单不命中，但标题是明确行业事件 → 保留进入 AI 筛选', async () => {
    const article = mockPendingArticle({ title: '便利店，正在被“便利”反杀' });
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    mocks.fetchArticleDetail.mockResolvedValueOnce('行业报告显示，便利店门店总量增长，但单店收入和客流同比下降。'.repeat(3));
    mocks.keywordFindMany.mockResolvedValueOnce([{ word: '奈雪' }]);

    const result = await processAllPending();

    expect(result.processed).toBe(1);
    expect(mocks.articleDelete).not.toHaveBeenCalled();
    expect(mocks.discardedItemUpsert).not.toHaveBeenCalled();
    expect(mocks.articleUpdate).toHaveBeenCalledWith({
      where: { id: 'art-001' },
      data: { keywordMatched: false },
    });
  });
});

describe('processAllPending 边界条件', () => {
  it('详情抓取失败（content 长度 ≤ 50）→ 跳过两道路闸，errors++', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    // fetchArticleDetail 返空（对应 detail-fetcher 返 '' 或 short）
    mocks.fetchArticleDetail.mockResolvedValueOnce('');

    const result = await processAllPending();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(1);
    expect(mocks.articleDelete).not.toHaveBeenCalled();
    expect(mocks.discardedItemUpsert).not.toHaveBeenCalled();
    // 详情抓取未完成时不执行关键字判断
    expect(mocks.keywordFindMany).not.toHaveBeenCalled();
  });

  it('详情抓取抛错时收口为 failed，避免同一 pending 文章在本轮无限重试', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    mocks.fetchArticleDetail.mockRejectedValueOnce(new Error('详情请求超时'));

    const result = await processAllPending();

    expect(result).toMatchObject({ processed: 0, errors: 1 });
    expect(mocks.markArticleFetchFailure).toHaveBeenCalledWith(
      'art-001',
      expect.any(Error),
      { onlyIfPending: true },
    );
  });

  it('关键字 DB 抛错 → 不删文章，宁可放过不可误杀（processed++）', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);
    mocks.fetchArticleDetail.mockResolvedValueOnce('某段抓回来的正文，length > 50 chars 假装有意义的内容'.repeat(2));
    // 关键字 DB 抛错
    mocks.keywordFindMany.mockRejectedValueOnce(new Error('DB down'));

    const result = await processAllPending();

    // 注意：errors 不增加（外层 try/catch 不触发，只有内层 keyword 的 try/catch 捕获）
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).not.toHaveBeenCalled();
    expect(mocks.discardedItemUpsert).not.toHaveBeenCalled();
  });
});

describe('repairPublishedDates 分页边界', () => {
  it('按固定窗口扫描近期开稿，不会一次读取整周 rawContent', async () => {
    const createdAt = new Date('2026-07-29T12:00:00.000Z');
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `normal-${index}`,
      title: `正常时间文章 ${index}`,
      rawContent: '<html></html>',
      publishedAt: new Date('2026-07-29T09:30:00.000Z'),
      createdAt,
    }));
    const repairable = {
      id: 'needs-repair',
      title: '待修复发布时间',
      rawContent: '<meta property="article:published_time" content="2026-07-28T08:15:00.000Z">',
      publishedAt: new Date('2026-07-28T00:00:00.000Z'),
      createdAt: new Date('2026-07-28T12:00:00.000Z'),
    };
    mocks.articleFindMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([repairable]);

    await repairPublishedDates();

    expect(mocks.articleFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.articleFindMany.mock.calls.every(([query]) => query.take === 20)).toBe(true);
    expect(mocks.articleFindMany.mock.calls[1][0].where.AND).toEqual([
      {
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lt: 'normal-19' } },
        ],
      },
    ]);
    expect(mocks.articleUpdate).toHaveBeenCalledWith({
      where: { id: 'needs-repair' },
      data: { publishedAt: new Date('2026-07-28T08:15:00.000Z') },
    });
    expect(mocks.refreshPublicPublication).toHaveBeenCalledWith(
      'needs-repair',
      expect.anything(),
      { contentChanged: true },
    );
  });
});
