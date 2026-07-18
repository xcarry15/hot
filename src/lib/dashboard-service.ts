import { db } from '@/lib/db';
import { pushableWhere, readPushSettings } from '@/lib/push/policy';

export interface DashboardStats {
  breakerSources: number;
  pendingProcess: number;
  pendingAi: number;
  failedAi: number;
  failedPush: number;
  urgentUnpushed: number;
  recentTaskFailures: number;
  recentFetchFailures: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pushSettings = await readPushSettings();
  const urgentWhere = pushSettings.pushMode === 'off'
    ? { id: '__push_disabled__' }
    : pushableWhere({ ...pushSettings, minScore: Math.max(95, pushSettings.minScore) });

  const [
    breakerSources,
    pendingProcess,
    pendingAi,
    failedAi,
    failedPush,
    urgentUnpushed,
    recentTaskFailures,
    recentFetchFailures,
  ] = await Promise.all([
    db.source.count({ where: { deletedAt: null, status: 'breaker' } }),
    db.article.count({ where: { fetchStatus: 'pending' } }),
    db.article.count({ where: { aiStatus: 'pending' } }),
    db.article.count({ where: { aiStatus: 'failed' } }),
    db.pushLog.count({ where: { status: 'failure', createdAt: { gte: last24Hours } } }),
    db.event.count({ where: urgentWhere }),
    db.job.count({ where: { status: 'failed', updatedAt: { gte: last24Hours } } }),
    db.fetchLog.count({ where: { status: 'failure', createdAt: { gte: last24Hours } } }),
  ]);

  return {
    breakerSources,
    pendingProcess,
    pendingAi,
    failedAi,
    failedPush,
    urgentUnpushed,
    recentTaskFailures,
    recentFetchFailures,
  };
}
