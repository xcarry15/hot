import { db } from '@/lib/db';
import { maskWebhookTarget } from '@/lib/webhook-display';

export async function listPushLogs(page: number, pageSize: number, status: string | null, source: string | null, webhookRemark: string | null) {
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (webhookRemark) where.webhookRemark = webhookRemark;
  if (source) where.article = { source: { name: source } };
  const [logs, total] = await Promise.all([
    db.pushLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, articleId: true, status: true, errorMessage: true, retryCount: true, webhookUrl: true, webhookRemark: true, createdAt: true, article: { select: { title: true, url: true, brand: true, category: true, score: true, publishedAt: true, source: { select: { name: true } } } } } }),
    db.pushLog.count({ where }),
  ]);
  return {
    items: logs.map(({ webhookUrl, ...log }) => ({
      ...log,
      webhookTarget: maskWebhookTarget(webhookUrl),
    })),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

export async function getPushLogStats() {
  const [statusGroups, webhookGroups, sourceGroups] = await Promise.all([
    db.pushLog.groupBy({ by: ['status'], _count: { _all: true } }),
    db.pushLog.groupBy({ by: ['webhookRemark'], _count: { _all: true } }),
    db.$queryRaw<Array<{ sourceName: string; count: number | bigint }>>`SELECT s.name AS sourceName, COUNT(*) AS count FROM push_logs pl INNER JOIN articles a ON a.id = pl.articleId INNER JOIN sources s ON s.id = a.sourceId GROUP BY s.id, s.name ORDER BY count DESC`,
  ]);
  const successCount = statusGroups.find((group) => group.status === 'success')?._count._all ?? 0;
  const total = statusGroups.reduce((sum, group) => sum + group._count._all, 0);
  return {
    status: { all: total, success: successCount, failure: total - successCount },
    sources: sourceGroups.map((group) => ({ name: group.sourceName, count: Number(group.count) })).sort((a, b) => b.count - a.count),
    webhooks: webhookGroups.map((group) => ({ remark: group.webhookRemark || '(无备注)', count: group._count._all })).sort((a, b) => b.count - a.count),
  };
}
