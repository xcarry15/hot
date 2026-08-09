import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';

export async function listPushLogs(
  page: number,
  pageSize: number,
  status: string | null,
  source: string | null,
  webhookRemark: string | null,
  emptyWebhookRemark = false,
  startAt?: Date,
  endAt?: Date,
) {
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (emptyWebhookRemark) where.webhookRemark = '';
  else if (webhookRemark) where.webhookRemark = webhookRemark;
  if (startAt || endAt) {
    where.createdAt = { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lte: endAt } : {}) };
  }
  if (source) {
    const articleIds = await db.article.findMany({
      where: { source: { name: source } },
      select: { id: true },
    });
    where.representativeArticleId = { in: articleIds.map((article) => article.id) };
  }
  const [logs, total] = await Promise.all([
    db.pushLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        eventId: true,
        representativeArticleId: true,
        status: true,
        errorMessage: true,
        retryCount: true,
        webhookRemark: true,
        createdAt: true,
        target: { select: { name: true } },
      },
    }),
    db.pushLog.count({ where }),
  ]);
  const representativeIds = [...new Set(logs.flatMap((log) => log.representativeArticleId ? [log.representativeArticleId] : []))];
  const articles = representativeIds.length > 0
    ? await db.article.findMany({
        where: { id: { in: representativeIds } },
        select: { id: true, title: true, url: true, brand: true, category: true, score: true, publishedAt: true, source: { select: { name: true } } },
      })
    : [];
  const articlesById = new Map(articles.map((article) => [article.id, article]));
  return {
    items: logs.map(({ target, ...log }) => ({
      ...log,
      articleId: log.representativeArticleId,
      article: log.representativeArticleId ? articlesById.get(log.representativeArticleId) ?? null : null,
      // PushTarget 的 name 只保存人工备注或脱敏目标名；日志不再读取 URL 字段。
      webhookTarget: target?.name || log.webhookRemark || '已删除的推送目标',
    })),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

export async function getPushLogStats(startAt?: Date, endAt?: Date) {
  const createdAt = startAt || endAt
    ? { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lte: endAt } : {}) }
    : undefined;
  const dateFilter = Prisma.sql`
    ${startAt ? Prisma.sql`AND pl.createdAt >= ${startAt}` : Prisma.empty}
    ${endAt ? Prisma.sql`AND pl.createdAt <= ${endAt}` : Prisma.empty}
  `;
  const [statusGroups, webhookGroups, sourceGroups] = await Promise.all([
    db.pushLog.groupBy({ where: createdAt ? { createdAt } : undefined, by: ['status'], _count: { _all: true } }),
    db.pushLog.groupBy({ where: createdAt ? { createdAt } : undefined, by: ['webhookRemark'], _count: { _all: true } }),
    db.$queryRaw<Array<{ sourceName: string; count: number | bigint }>>`SELECT s.name AS sourceName, COUNT(*) AS count FROM push_logs pl INNER JOIN articles a ON a.id = pl.representativeArticleId INNER JOIN sources s ON s.id = a.sourceId WHERE 1 = 1 ${dateFilter} GROUP BY s.id, s.name ORDER BY count DESC`,
  ]);
  const successCount = statusGroups.find((group) => group.status === 'success')?._count._all ?? 0;
  const total = statusGroups.reduce((sum, group) => sum + group._count._all, 0);
  return {
    status: { all: total, success: successCount, failure: total - successCount },
    sources: sourceGroups.map((group) => ({ name: group.sourceName, count: Number(group.count) })).sort((a, b) => b.count - a.count),
    webhooks: webhookGroups.map((group) => ({
      remark: group.webhookRemark || '(无备注)',
      isEmpty: group.webhookRemark === '',
      count: group._count._all,
    })).sort((a, b) => b.count - a.count),
  };
}
