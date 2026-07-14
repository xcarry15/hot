/**
 * Article 应用服务单元测试。
 *
 * 锁定：
 *   - buildArticleListWhere / buildArticleDeleteWhere 类型化筛选构造
 *   - listArticles / getArticleDetail / deleteArticlesByIds / deleteArticlesByFilter 的调用语义
 *   - 单条 DELETE / 详情 GET 等通过路由测试覆盖（articles-delete.test.ts）
 *
 * 不在本文模拟：与 runJob 的异步集成（仍由 execution-concurrency.test.ts 覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleGroupBy: vi.fn(),
  articleFindUnique: vi.fn(),
  articleDeleteMany: vi.fn(),
  articleDelete: vi.fn(),
  articleCount: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      groupBy: mocks.articleGroupBy,
      findUnique: mocks.articleFindUnique,
      deleteMany: mocks.articleDeleteMany,
      delete: mocks.articleDelete,
      count: mocks.articleCount,
    },
    pushLog: {
      deleteMany: mocks.pushLogDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  buildArticleDeleteWhere,
  buildArticleListWhere,
  deleteArticleById,
  deleteArticlesByFilter,
  deleteArticlesByIds,
  getArticleDetail,
  listArticles,
} from '@/lib/article-service';

describe('article-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleGroupBy.mockResolvedValue([]);
  });

  describe('typed filter builders', () => {
    it('buildArticleListWhere 缺省字段不写入 where', () => {
      expect(buildArticleListWhere({})).toEqual({});
    });

    it('buildArticleListWhere 忽略 NaN，避免无效 query 污染 Prisma where', () => {
      expect(buildArticleListWhere({ minScore: Number.NaN, minRelevance: Number.NaN })).toEqual({});
    });

    it('buildArticleListWhere 完整条件映射到 Prisma where', () => {
      expect(
        buildArticleListWhere({
          aiStatus: 'pending',
          brandContains: '肯',
          category: '餐饮',
          minScore: 60,
          minRelevance: 70,
          sourceId: 'src-1',
          search: '咖啡',
        }),
      ).toEqual({
        aiStatus: 'pending',
        brand: { contains: '肯' },
        category: '餐饮',
        score: { gte: 60 },
        relevance: { gte: 70 },
        sourceId: 'src-1',
        OR: [
          { title: { contains: '咖啡' } },
          { summary: { contains: '咖啡' } },
          { brand: { contains: '咖啡' } },
        ],
      });
    });

    it('buildArticleDeleteWhere 仅 status / category / maxScore；空对象允许（保持历史"全删"语义）', () => {
      expect(buildArticleDeleteWhere({})).toEqual({});
      expect(
        buildArticleDeleteWhere({ aiStatus: 'skipped', category: '餐饮', maxScore: 40 }),
      ).toEqual({ aiStatus: 'skipped', category: '餐饮', score: { lte: 40 } });
    });

    it('buildArticleDeleteWhere 忽略 NaN，保持无 maxScore 时的全删语义', () => {
      expect(buildArticleDeleteWhere({ maxScore: Number.NaN })).toEqual({});
    });
  });

  describe('listArticles', () => {
    it('分页上限不超过 100，orderBy 固定 publishedAt desc → createdAt desc', async () => {
      mocks.articleFindMany.mockResolvedValue([]);
      mocks.articleCount.mockResolvedValue(0);

      await listArticles({ page: 1, pageSize: 999, filter: { aiStatus: 'failed' } });

      const call = mocks.articleFindMany.mock.calls[0][0];
      expect(call.take).toBe(100);
      expect(call.orderBy).toEqual([{ publishedAt: 'desc' }, { createdAt: 'desc' }]);
      expect(call.skip).toBe(0);
      expect(call.where).toEqual({ aiStatus: 'failed' });
      // select 必含 source 摘要
      expect(call.select.source).toEqual({ select: { name: true, type: true } });
    });

    it('计数与 findMany 并行；返回 totalPages=0 当 total=0', async () => {
      mocks.articleFindMany.mockResolvedValue([]);
      mocks.articleCount.mockResolvedValue(0);

      const result = await listArticles({ pageSize: 20 });
      expect(result).toMatchObject({
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        items: [],
      });
    });

    it('non-zero total → ceil(total/pageSize)', async () => {
      mocks.articleFindMany.mockResolvedValue([]);
      mocks.articleCount.mockResolvedValue(25);
      const result = await listArticles({ pageSize: 10 });
      expect(result.totalPages).toBe(3);
    });
  });

  describe('getArticleDetail', () => {
    it('not found 返回 null，不抛错', async () => {
      mocks.articleFindUnique.mockResolvedValue(null);
      await expect(getArticleDetail('missing')).resolves.toBeNull();
    });

    it('命中时 select 含 source 详情 + 最近 5 条 pushLogs', async () => {
      // 提供 serializeArticleDetail 所需的最小字段集（DATED 字段用 ISO 字符串避免被 toRequiredIso 抛错）
      const found = {
        id: 'a1',
        sourceId: 'src-1',
        url: 'https://example.com',
        title: 't',
        originalSource: null,
        rawContent: '',
        cleanContent: '',
        contentHash: 'h',
        fetchStatus: 'done',
        articleBody: '',
        relevance: 0,
        summary: '',
        brand: '',
        category: '',
        tags: '[]',
        keyPoints: '[]',
        score: 0,
        promptVersion: 'v1',
        aiStatus: 'pending',
        skipReason: null,
        dedupDetail: null,
        aiRetryCount: 0,
        nextAiRetryAt: null,
        isAd: false,
        pushedAt: null,
        nextRetryAt: null,
        pushUrgency: '',
        publishedAt: null,
        createdAt: new Date('2026-07-11T00:00:00.000Z'),
        updatedAt: new Date('2026-07-11T00:00:00.000Z'),
        source: { name: '餐饮88', type: 'rss', url: 'https://example.com' },
        pushLogs: [],
      };
      mocks.articleFindUnique.mockResolvedValue(found);

      const dto = await getArticleDetail('a1');
      expect(dto).not.toBeNull();
      // 取出被传入 findUnique 的 args，验证 select 形状
      const call = mocks.articleFindUnique.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a1' });
      expect(call.select.source).toEqual({
        select: { name: true, type: true, url: true },
      });
      expect(call.select.pushLogs).toMatchObject({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });
  });

  describe('deleteArticlesByIds', () => {
    it('空数组直接返回零计数，不进入事务', async () => {
      const result = await deleteArticlesByIds([]);
      expect(result).toEqual({ deleted: 0, pushLogsDeleted: 0 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('过滤空字符串后空数组同样短路', async () => {
      const result = await deleteArticlesByIds(['', '', '']);
      expect(result).toEqual({ deleted: 0, pushLogsDeleted: 0 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('单次 $transaction 调用，args 是包含 pushLog+article 的数组', async () => {
      mocks.transaction.mockImplementation(() =>
        Promise.resolve([{ count: 2 }, { count: 3 }]),
      );

      const result = await deleteArticlesByIds(['a1', 'a2', 'a3']);
      expect(result).toEqual({ deleted: 3, pushLogsDeleted: 2 });

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      // 我们只断言"被调一次 + 传的是数组"，不深入 PrismaPromise 内部
      expect(Array.isArray(mocks.transaction.mock.calls[0][0])).toBe(true);
      expect(mocks.transaction.mock.calls[0][0]).toHaveLength(2);
    });
  });

  describe('deleteArticleById', () => {
    it('先 pushLogs(articleId=id) 再 article.delete by id', async () => {
      mocks.pushLogDeleteMany.mockResolvedValue({ count: 0 });
      mocks.articleDelete.mockResolvedValue({});

      await deleteArticleById('a1');

      expect(mocks.pushLogDeleteMany).toHaveBeenCalledWith({
        where: { articleId: 'a1' },
      });
      expect(mocks.articleDelete).toHaveBeenCalledWith({
        where: { id: 'a1' },
      });
      // pushLog 必须在 article.delete 之前
      expect(mocks.pushLogDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.articleDelete.mock.invocationCallOrder[0],
      );
    });
  });

  describe('deleteArticlesByFilter', () => {
    it('deleteArticlesByFilter：findMany 取 ids 后复用 deleteArticlesByIds', async () => {
      mocks.articleFindMany.mockResolvedValue([{ id: 'x1' }, { id: 'x2' }]);
      mocks.transaction.mockImplementation(() =>
        Promise.resolve([{ count: 2 }, { count: 2 }]),
      );

      const result = await deleteArticlesByFilter({ aiStatus: 'skipped' });
      expect(result).toEqual({ deleted: 2, pushLogsDeleted: 2 });
      expect(mocks.articleFindMany).toHaveBeenCalledWith({
        where: { aiStatus: 'skipped' },
        select: { id: true },
      });
    });

    it('deleteArticlesByFilter：空结果短路 deleteArticlesByIds（不调 transaction）', async () => {
      mocks.articleFindMany.mockResolvedValue([]);
      const result = await deleteArticlesByFilter({ aiStatus: 'skipped' });
      expect(result).toEqual({ deleted: 0, pushLogsDeleted: 0 });
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('deleteArticlesByFilter：空 filter 仍走历史"全删"语义（不限流）', async () => {
      mocks.articleFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      mocks.transaction.mockImplementation(() =>
        Promise.resolve([{ count: 2 }, { count: 2 }]),
      );
      const result = await deleteArticlesByFilter({});
      expect(result.deleted).toBe(2);
      // findMany 收到的 where 就是空对象
      expect(mocks.articleFindMany.mock.calls[0][0].where).toEqual({});
    });

  });
});
