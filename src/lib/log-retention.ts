import type { PrismaClient } from '@prisma/client';

/**
 * 日志保留周期：按表的业务用途区分，不通过删除 Article 影响业务数据。
 * PushLog 只有在 Article 已完成全部目标投递（pushedAt 非空）后才允许清理，
 * 避免丢失部分成功事实导致重试时重复推送。
 */
export const LOG_RETENTION_DAYS = {
  fetchLogs: 30,
  pushLogs: 90,
  completedJobs: 30,
} as const;

export type LogRetentionDb = Pick<PrismaClient, 'fetchLog' | 'pushLog' | 'job'>;

function beforeDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function getLogRetentionCutoffs(now = new Date()) {
  return {
    fetchLogsBefore: beforeDays(now, LOG_RETENTION_DAYS.fetchLogs),
    pushLogsBefore: beforeDays(now, LOG_RETENTION_DAYS.pushLogs),
    completedJobsBefore: beforeDays(now, LOG_RETENTION_DAYS.completedJobs),
  };
}

export async function purgeExpiredLogs(db: LogRetentionDb, now = new Date()) {
  const cutoffs = getLogRetentionCutoffs(now);
  const [fetchLogs, pushLogs, completedJobs] = await Promise.all([
    db.fetchLog.deleteMany({
      where: { createdAt: { lt: cutoffs.fetchLogsBefore } },
    }),
    db.pushLog.deleteMany({
      where: {
        createdAt: { lt: cutoffs.pushLogsBefore },
        // 未完成投递的 Article 仍依赖 PushLog 成功记录作为目标级事实。
        event: { pushedAt: { not: null } },
      },
    }),
    db.job.deleteMany({
      where: {
        status: { in: ['completed', 'failed'] },
        createdAt: { lt: cutoffs.completedJobsBefore },
      },
    }),
  ]);

  return {
    fetchLogs: fetchLogs.count,
    pushLogs: pushLogs.count,
    completedJobs: completedJobs.count,
    total: fetchLogs.count + pushLogs.count + completedJobs.count,
    cutoffs,
  };
}
