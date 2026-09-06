import { describe, expect, it, vi } from 'vitest';
import { getLogRetentionCutoffs, LOG_RETENTION_DAYS, purgeExpiredLogs } from '@/lib/log-retention';

describe('log retention', () => {
  it('固定保留周期从同一个基准时间计算', () => {
    const now = new Date('2026-07-11T00:00:00.000Z');
    const cutoffs = getLogRetentionCutoffs(now);

    expect(LOG_RETENTION_DAYS).toEqual({ fetchLogs: 30, pushLogs: 90, completedJobs: 30, aiInvocations: 90 });
    expect(cutoffs.fetchLogsBefore.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(cutoffs.pushLogsBefore.toISOString()).toBe('2026-04-12T00:00:00.000Z');
    expect(cutoffs.completedJobsBefore.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(cutoffs.aiInvocationsBefore.toISOString()).toBe('2026-04-12T00:00:00.000Z');
  });

  it('只清理安全范围，保留未完成投递的 PushLog 和运行中 Job', async () => {
    const db = {
      fetchLog: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      pushLog: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      job: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiInvocation: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
    };
    const result = await purgeExpiredLogs(db as never, new Date('2026-07-11T00:00:00.000Z'));

    expect(result).toMatchObject({ fetchLogs: 2, pushLogs: 3, completedJobs: 1, aiInvocations: 4, total: 10 });
    expect(db.fetchLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-06-11T00:00:00.000Z') } },
    });
    expect(db.pushLog.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date('2026-04-12T00:00:00.000Z') },
        event: { pushedAt: { not: null } },
      },
    });
    expect(db.job.deleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['succeeded', 'completed', 'failed', 'cancelled'] },
        createdAt: { lt: new Date('2026-06-11T00:00:00.000Z') },
      },
    });
  });
});
