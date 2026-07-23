import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { deleteLowQualityArticles, executeMaintenanceAction, getCleanupStats, resetAllAi, resetFailedAi } from '@/lib/maintenance-service';

const mocks = db as unknown as {
  article: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  event: { count: ReturnType<typeof vi.fn> };
  fetchLog: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  pushLog: { count: ReturnType<typeof vi.fn> };
  discardedItem: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
};

const getDbFileSize = vi.hoisted(() => vi.fn());
const runVacuum = vi.hoisted(() => vi.fn());
const recalculateEventsInTransaction = vi.hoisted(() => vi.fn());
const deleteArticlesByIds = vi.hoisted(() => vi.fn());
vi.mock('@/lib/maintenance/sqlite', () => ({ getDbFileSize, runVacuum }));
vi.mock('@/lib/article-service', () => ({ deleteArticlesByIds }));
vi.mock('@/lib/public-publication-service', () => ({ rebuildPublicPublicationSnapshot: vi.fn() }));
vi.mock('@/lib/public-article-cache', () => ({ invalidatePublicArticleCache: vi.fn() }));
vi.mock('@/lib/event-service', () => ({ recalculateEventsInTransaction }));

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

  it('重置全部 AI 时解除旧 Event 并重置聚类状态', async () => {
    const article = {
      id: 'article-1', eventId: 'event-1', aiStatus: 'done', manualOverrides: '[]', manualCorrectedAt: null,
      relevance: 80, summary: '摘要', brand: '[]', category: '零售', eventSubjects: '[]', eventAction: '',
      eventObject: '', keyPoints: '[]', eventScore: 70, contentScore: 60, adProbability: 5, isAd: false,
    };
    const tx = {
      article: { findMany: vi.fn().mockResolvedValue([article]), update: vi.fn().mockResolvedValue({}) },
      eventClusterAudit: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(resetAllAi()).resolves.toEqual({ reset: 1 });
    expect(tx.eventClusterAudit.deleteMany).toHaveBeenCalledWith({ where: { articleId: { in: ['article-1'] } } });
    expect(tx.article.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'article-1' },
      data: expect.objectContaining({ aiStatus: 'pending', event: { disconnect: true }, clusterStatus: 'pending' }),
    }));
    expect(recalculateEventsInTransaction).toHaveBeenCalledWith(tx, ['event-1']);
  });

  it('重置失败 AI 不包含正常跳过文章', async () => {
    const tx = {
      article: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
      eventClusterAudit: { deleteMany: vi.fn() },
    };
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(resetFailedAi()).resolves.toEqual({ reset: 0 });
    expect(tx.article.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { aiStatus: 'failed' },
          { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
        ],
      },
    });
  });

  it('低质量清理不会删除无具体事件或多事件聚合稿', async () => {
    mocks.article.findMany.mockResolvedValue([{ id: 'technical-failure' }]);
    deleteArticlesByIds.mockResolvedValue({ deleted: 1 });

    await expect(deleteLowQualityArticles()).resolves.toEqual({ deleted: 1 });
    expect(mocks.article.findMany).toHaveBeenCalledWith({
      where: {
        score: { lt: 40 },
        aiStatus: 'skipped',
        skipReason: { startsWith: '内容不足' },
      },
      select: { id: true },
    });
    expect(deleteArticlesByIds).toHaveBeenCalledWith(['technical-failure']);
  });
});
