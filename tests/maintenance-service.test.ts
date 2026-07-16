/**
 * Maintenance 应用服务单元测试。
 *
 * 锁定 `getCleanupStats()` 的响应字段与数量语义，
 * 以及 `executeMaintenanceAction` 在 reset / clear / vacuum 上的 dispatch 行为。
 * 事务、暂停/恢复 scheduler 等更复杂的语义仍在 cleanup-n-plus-one.test.ts
 * 通过 Route 端到端覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleCount: vi.fn(),
  discardedItemCount: vi.fn(),
  fetchLogCount: vi.fn(),
  pushLogCount: vi.fn(),
  jobCount: vi.fn(),
  articleUpdateMany: vi.fn(),
  articleFindMany: vi.fn(),
  articleUpdate: vi.fn(),
  settingFindUnique: vi.fn(),
  discardedItemDeleteMany: vi.fn(),
  fetchLogDeleteMany: vi.fn(),
  pushLogDeleteMany: vi.fn(),
  discardedRetryAuditDeleteMany: vi.fn(),
  transaction: vi.fn(),
  executeRawUnsafe: vi.fn(),
  getDbFileSize: vi.fn(),
}));

// SQLite adapter 部分用 mock 替换，绕过 fs 访问
vi.mock('@/lib/maintenance/sqlite', () => ({
  getDbFileSize: mocks.getDbFileSize,
  runVacuum: vi.fn(async () => ({
    vacuumed: true as const,
    sizeBefore: 1000,
    sizeAfter: 800,
    saved: 200,
  })),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      count: mocks.articleCount,
      updateMany: mocks.articleUpdateMany,
      findMany: mocks.articleFindMany,
      update: mocks.articleUpdate,
    },
    setting: { findUnique: mocks.settingFindUnique },
    discardedItem: {
      count: mocks.discardedItemCount,
      deleteMany: mocks.discardedItemDeleteMany,
    },
    discardedRetryAudit: {
      deleteMany: mocks.discardedRetryAuditDeleteMany,
    },
    fetchLog: {
      count: mocks.fetchLogCount,
      deleteMany: mocks.fetchLogDeleteMany,
    },
    pushLog: {
      count: mocks.pushLogCount,
      deleteMany: mocks.pushLogDeleteMany,
    },
    job: { count: mocks.jobCount },
    $transaction: mocks.transaction,
    $executeRawUnsafe: mocks.executeRawUnsafe,
  },
}));

vi.mock('@/lib/worker-stop', () => ({
  abortCurrentJob: vi.fn(),
}));

import {
  executeMaintenanceAction,
  getCleanupStats,
} from '@/lib/maintenance-service';

describe('maintenance-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认计数返回
    mocks.articleCount.mockResolvedValue(0);
    mocks.discardedItemCount.mockResolvedValue(0);
    mocks.fetchLogCount.mockResolvedValue(0);
    mocks.pushLogCount.mockResolvedValue(0);
    mocks.jobCount.mockResolvedValue(0);
    mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.articleUpdate.mockResolvedValue({});
    mocks.settingFindUnique.mockResolvedValue(undefined);
    mocks.discardedRetryAuditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.transaction.mockImplementation(async (operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
      if (typeof operations === 'function') {
        return operations({
          setting: { findUnique: mocks.settingFindUnique },
          article: { findMany: mocks.articleFindMany, update: mocks.articleUpdate, updateMany: mocks.articleUpdateMany },
        });
      }
      return Promise.all(operations);
    });
    mocks.getDbFileSize.mockReturnValue(0);
  });

  describe('getCleanupStats', () => {
    it('并行执行 9 个 count + db 文件大小，字段完整', async () => {
      mocks.articleCount
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(2)  // low-quality
        .mockResolvedValueOnce(3)  // pushed
        .mockResolvedValueOnce(4); // pending
      mocks.discardedItemCount
        .mockResolvedValueOnce(1)  // dedup
        .mockResolvedValueOnce(5); // total
      mocks.fetchLogCount.mockResolvedValueOnce(7);
      mocks.pushLogCount.mockResolvedValueOnce(8);
      mocks.jobCount.mockResolvedValueOnce(9);
      mocks.getDbFileSize.mockReturnValueOnce(4096);

      const stats = await getCleanupStats();

      expect(stats).toEqual({
        articlesTotal: 10,
        articlesLowQuality: 2,
        articlesPushed: 3,
        articlesPending: 4,
        dedupLogs: 1,
        fetchLogs: 7,
        pushLogs: 8,
        discardedTotal: 5,
        jobsTotal: 9,
        dbSizeBytes: 4096,
      });
      // 9 个 count 都是 Promise.all 内的并行调用
      expect(mocks.articleCount).toHaveBeenCalledTimes(5);
      expect(mocks.discardedItemCount).toHaveBeenCalledTimes(2);
    });

    it('低质量 where = score<40 ∩ aiStatus∈{skipped,failed}', async () => {
      await getCleanupStats();
      const calls = mocks.articleCount.mock.calls.map((c) => c[0]);
      // 第 2 次 article.count 是低质量
      expect(calls[1]).toEqual({
        where: { score: { lt: 40 }, aiStatus: { in: ['skipped', 'failed'] } },
      });
      // 已推送 / pending / total 的 where 也对应
      expect(calls[0]).toBeUndefined(); // total 无 where
      expect(calls[2]).toEqual({ where: { pushedAt: { not: null } } });
      expect(calls[3]).toEqual({ where: { aiStatus: { in: ['pending', 'failed'] } } });
    });

    it('dedupLogs where = reason startsWith "dedup:"', async () => {
      await getCleanupStats();
      const calls = mocks.discardedItemCount.mock.calls.map((c) => c[0]);
      expect(calls[0]).toEqual({ where: { reason: { startsWith: 'dedup:' } } });
      expect(calls[1]).toBeUndefined(); // discardedTotal
    });
  });

  describe('executeMaintenanceAction — reset / clear / vacuum', () => {
    it('reset-ai 调 updateMany where aiStatus != pending', async () => {
      mocks.articleUpdateMany.mockResolvedValue({ count: 4 });
      const result = await executeMaintenanceAction('reset-ai');
      expect(result).toEqual({ reset: 4 });
      expect(mocks.articleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { aiStatus: { not: 'pending' } },
        }),
      );
    });

    it('reset-ai-failed 调 updateMany where aiStatus ∈ {failed, skipped}', async () => {
      mocks.articleUpdateMany.mockResolvedValue({ count: 2 });
      const result = await executeMaintenanceAction('reset-ai-failed');
      expect(result).toEqual({ reset: 2 });
      expect(mocks.articleUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { aiStatus: { in: ['failed', 'skipped'] } },
        }),
      );
    });

    it('reset-ai 重置业务字段与所有 AI 重试/判定残留', async () => {
      mocks.articleUpdateMany.mockResolvedValue({ count: 0 });
      await executeMaintenanceAction('reset-ai');
      const { data } = mocks.articleUpdateMany.mock.calls[0][0];
      expect(data).toEqual({
        aiStatus: 'pending',
        relevance: 0,
        summary: '',
        brand: '',
        category: '',
        tags: '[]',
        keyPoints: '[]',
        score: 0,
        eventScore: null,
        contentScore: null,
        rawScore: null,
        adProbability: null,
        aiConfidence: null,
        scorePolicyVersion: '',
        aiModel: '',
        aiProvider: '',
        promptHash: '',
        scorePolicySnapshot: '',
        promptVersion: 'v1',
        isAd: false,
        aiRetryCount: 0,
        nextAiRetryAt: null,
        skipReason: null,
        dedupDetail: null,
        duplicateStatus: 'none',
        duplicateOfId: null,
        dedupOverride: false,
      });
    });

    it('dedup-logs 仅删 reason 以 "dedup:" 起头的丢弃项', async () => {
      mocks.discardedItemDeleteMany.mockResolvedValue({ count: 6 });
      const result = await executeMaintenanceAction('dedup-logs');
      expect(result).toEqual({ deleted: 6 });
      expect(mocks.discardedItemDeleteMany).toHaveBeenCalledWith({
        where: { reason: { startsWith: 'dedup:' } },
      });
    });

    it('fetch-logs 不带 where 全量删除', async () => {
      mocks.fetchLogDeleteMany.mockResolvedValue({ count: 11 });
      const result = await executeMaintenanceAction('fetch-logs');
      expect(result).toEqual({ deleted: 11 });
      expect(mocks.fetchLogDeleteMany).toHaveBeenCalledWith();
    });

    it('vacuum 委托给 runVacuum，不再走 executeRawUnsafe', async () => {
      const result = await executeMaintenanceAction('vacuum');
      expect(result).toEqual({
        vacuumed: true,
        sizeBefore: 1000,
        sizeAfter: 800,
        saved: 200,
      });
      expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
