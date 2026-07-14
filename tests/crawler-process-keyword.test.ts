/**
 * processAllPending 阶段集成测试
 *
 * 覆盖:
 * - Gate 1（全文内容指纹/正文 LCS 去重）：命中 → 删除 + DiscardedItem
 * - Gate 2（全文关键字匹配）：不命中 → 删除 + DiscardedItem
 * - 详情抓取失败：跳过两道路闸
 * - 关键字 DB 抛错：宁可放过不可误杀（fall through 到 processed++）
 *
 * 背景：tranquil-petting-goose.md — 把 collect 阶段的内容去重 + 关键字匹配
 * 搬到 process 阶段，让两个判定都基于全文（而非列表页摘要）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  // db.article
  articleFindMany: vi.fn(),
  articleUpdate: vi.fn(),
  articleUpdateMany: vi.fn(),
  articleDelete: vi.fn(),
  articleFindFirst: vi.fn(),
  articleFindUnique: vi.fn(),
  // db.discardedItem
  discardedItemUpsert: vi.fn(),
  // db.source
  sourceUpdate: vi.fn(),
  sourceFindUnique: vi.fn(),
  // db.setting (dedup config)
  settingFindUnique: vi.fn(),
  // db.keyword (matchKeyword)
  keywordFindMany: vi.fn(),
  // detail-fetcher
  fetchArticleDetail: vi.fn(),
  // utils-shared
  withTimeout: vi.fn(),
  abortableDelay: vi.fn(),
  // worker-stop
  assertNotAborted: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      update: mocks.articleUpdate,
      updateMany: mocks.articleUpdateMany,
      delete: mocks.articleDelete,
      findFirst: mocks.articleFindFirst,
      findUnique: mocks.articleFindUnique,
    },
    discardedItem: {
      upsert: mocks.discardedItemUpsert,
    },
    source: {
      update: mocks.sourceUpdate,
      findUnique: mocks.sourceFindUnique,
    },
    setting: {
      findUnique: mocks.settingFindUnique,
    },
    keyword: {
      findMany: mocks.keywordFindMany,
    },
  },
}));

vi.mock('@/lib/detail-fetcher', () => ({
  fetchArticleDetail: mocks.fetchArticleDetail,
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

import { processAllPending } from '../src/lib/pipeline/process';
import { computeContentFingerprint } from '../src/lib/dedup';
import { invalidateKeywordCache } from '../src/lib/filter';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateKeywordCache();
  // 默认 withTimeout 直接透传
  mocks.withTimeout.mockImplementation((operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal));
  mocks.abortableDelay.mockResolvedValue(undefined);
  // 默认 fetchArticleDetail 返空（测试需要时再覆盖）
  mocks.fetchArticleDetail.mockResolvedValue('');
  // 默认 article.findMany（dedup 候选 + repairPublishedDates）返空
  mocks.articleFindMany.mockResolvedValue([]);
  // 默认 article.findFirst（指纹去重）无命中
  mocks.articleFindFirst.mockResolvedValue(null);
  // 默认 article.update / updateMany / delete 返 {}
  mocks.articleUpdate.mockResolvedValue({});
  mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
  mocks.articleDelete.mockResolvedValue({});
  // 默认 discardedItem.upsert 返 {}
  mocks.discardedItemUpsert.mockResolvedValue({});
  // 默认 source / setting 返空
  mocks.sourceUpdate.mockResolvedValue({});
  mocks.sourceFindUnique.mockResolvedValue(null);
  // 默认 dedup config：让所有数值走默认（getDedupConfig 内 clamp 到默认）
  mocks.settingFindUnique.mockResolvedValue(null);
  // 默认 keyword DB 空 → matchKeyword 返 true
  mocks.keywordFindMany.mockResolvedValue([]);
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

describe('processAllPending Gate 2: 全文关键字匹配', () => {
  it('正文命中关键字 + 无去重 → 文章保留，processed++', async () => {
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
});

describe('processAllPending Gate 1: 全文内容去重', () => {
  it('指纹去重命中 → 文章删除 + DiscardedItem 写入 dedup:content，winnerArticleId 指向赢家', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);

    // 详情抓回一段足够长的文字（> 50 字符才能进入 process gates）
    const sharedContent = '奈雪发布2026战略：计划新开300家门店聚焦一二线城市，进一步扩大品牌影响力'.repeat(2);
    mocks.fetchArticleDetail.mockResolvedValueOnce(sharedContent);

    // fingerprint 查询命中一篇已有同指纹的 Article（赢家）
    const winnerId = 'winner-999';
    mocks.articleFindMany.mockResolvedValueOnce([{
      id: winnerId,
      url: 'https://other.example.com/naixue-2026',
      title: '奈雪2026战略发布',
      cleanContent: sharedContent,
      contentHash: computeContentFingerprint('奈雪发布2026战略', sharedContent),
      publishedAt: new Date('2026-01-01'),
    }]);

    const result = await processAllPending();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).toHaveBeenCalledWith({ where: { id: 'art-001' } });
    expect(mocks.discardedItemUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mocks.discardedItemUpsert.mock.calls[0][0];
    expect(upsertArgs.create.reason).toBe('dedup:content');
    expect(upsertArgs.create.winnerArticleId).toBe(winnerId);
  });

  it('正文 LCS 去重命中 → 文章删除 + DiscardedItem 写入 dedup:near', async () => {
    const article = mockPendingArticle();
    mocks.articleFindMany.mockResolvedValueOnce([article]);

    // 构造两段都 ≥ 150 字符（bodyLcsMin）的多段 LCS，确保累计 ≥ lcsTotalMin (200)。
    // 单元 '行业新闻报道A' = 7 字符。repeat(40) → 280 字符。
    // 候选 = 前 200 字符（足够撑第一段 LCS）+ 'XXX' + 后 80 字符（撑第二段 LCS）。
    const incomingContent = '行业新闻报道A'.repeat(40);
    const candidateContent = incomingContent.slice(0, 200) + 'XXX' + incomingContent.slice(200);

    mocks.fetchArticleDetail.mockResolvedValueOnce(incomingContent);
    // 指纹未命中
    mocks.articleFindMany.mockResolvedValueOnce([]);
    // 候选池中有一篇相似正文（cleanContent 字段）
    mocks.articleFindMany.mockResolvedValueOnce([
      {
        id: 'old-001',
        title: '行业新闻报道A',
        url: 'https://old.example.com/a',
        cleanContent: candidateContent,
        contentHash: computeContentFingerprint('行业新闻报道A', candidateContent),
        publishedAt: new Date('2026-01-01'),
      },
    ]);

    const result = await processAllPending();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mocks.articleDelete).toHaveBeenCalledWith({ where: { id: 'art-001' } });
    expect(mocks.discardedItemUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mocks.discardedItemUpsert.mock.calls[0][0];
    expect(upsertArgs.create.reason).toBe('dedup:near');
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
    // 关键字 / 去重都不应该被调用
    expect(mocks.articleFindFirst).not.toHaveBeenCalled();
    expect(mocks.keywordFindMany).not.toHaveBeenCalled();
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
