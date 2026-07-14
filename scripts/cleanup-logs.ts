/**
 * 按固定保留周期清理历史日志。
 *
 * 只删除：过期 FetchLog、已完成全部推送 Article 的过期 PushLog、过期已结束 Job。
 * 不删除 Article、Source、DiscardedItem，也不触碰 pending/running Job。
 *
 * 用法：npm run db:cleanup-logs
 */
import { PrismaClient } from '@prisma/client';
import { purgeExpiredLogs } from '../src/lib/log-retention';

const db = new PrismaClient();

purgeExpiredLogs(db)
  .then((result) => {
    console.log('[cleanup-logs] 清理完成:', {
      fetchLogs: result.fetchLogs,
      pushLogs: result.pushLogs,
      completedJobs: result.completedJobs,
      total: result.total,
    });
  })
  .catch((error: unknown) => {
    console.error('[cleanup-logs] 清理失败:', error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
