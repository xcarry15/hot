import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { executeMaintenanceAction, getCleanupStats } from '@/lib/maintenance-service';

const mocks = db as unknown as {
  article: { count: ReturnType<typeof vi.fn> };
  event: { count: ReturnType<typeof vi.fn> };
  fetchLog: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  pushLog: { count: ReturnType<typeof vi.fn> };
  discardedItem: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
};

const getDbFileSize = vi.hoisted(() => vi.fn());
const runVacuum = vi.hoisted(() => vi.fn());
vi.mock('@/lib/maintenance/sqlite', () => ({ getDbFileSize, runVacuum }));
vi.mock('@/lib/article-service', () => ({ deleteArticlesByIds: vi.fn() }));
vi.mock('@/lib/public-publication-service', () => ({ rebuildPublicPublicationSnapshot: vi.fn() }));
vi.mock('@/lib/public-article-cache', () => ({ invalidatePublicArticleCache: vi.fn() }));

describe('maintenance-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.article.count.mockResolvedValueOnce(100).mockResolvedValueOnce(4).mockResolvedValueOnce(7);
    mocks.event.count.mockResolvedValueOnce(6).mockResolvedValueOnce(9);
    mocks.fetchLog.count.mockResolvedValue(11);
    mocks.pushLog.count.mockResolvedValue(12);
    mocks.discardedItem.count.mockResolvedValue(13);
    mocks.job.count.mockResolvedValue(14);
    getDbFileSize.mockReturnValue(2048);
  });

  it('清理统计使用有界数据库聚合，不拉取业务记录', async () => {
    await expect(getCleanupStats()).resolves.toEqual({
      articlesTotal: 100,
      articlesLowQuality: 4,
      articlesPushed: 6,
      articlesPending: 7,
      dedupLogs: 9,
      fetchLogs: 11,
      pushLogs: 12,
      discardedTotal: 13,
      jobsTotal: 14,
      dbSizeBytes: 2048,
    });
  });

  it('维护 action 只路由到明确用例', async () => {
    mocks.discardedItem.deleteMany.mockResolvedValue({ count: 3 });
    mocks.fetchLog.deleteMany.mockResolvedValue({ count: 5 });
    runVacuum.mockResolvedValue({ vacuumed: true, sizeBefore: 10, sizeAfter: 4, saved: 6 });

    await expect(executeMaintenanceAction('dedup-logs')).resolves.toEqual({ deleted: 3 });
    expect(mocks.discardedItem.deleteMany).toHaveBeenCalledWith({ where: { reason: { startsWith: 'dedup:' } } });
    await expect(executeMaintenanceAction('fetch-logs')).resolves.toEqual({ deleted: 5 });
    await expect(executeMaintenanceAction('vacuum')).resolves.toEqual({ vacuumed: true, sizeBefore: 10, sizeAfter: 4, saved: 6 });
  });
});
