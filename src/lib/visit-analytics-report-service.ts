import { db } from '@/lib/db';
import { isVisitGeoConfigured } from '@/lib/visit-geolocation';
import { comparisonRange, type CompareMode } from '@/lib/visit-analytics-service';
import type { Availability } from '@/lib/visit-analytics-presentation';

const numeric = (v: bigint | number) => Number(v);
/** 各指标是否有任何采集记录：0 与"从未采集"必须区分，否则会把采集故障显示成下跌 100%。 */
function metricAvailability(hasEvents: boolean, hasSessions: boolean, hasTools: boolean, hasInteractions: boolean): Availability {
  return {
    visitors: hasEvents, views: hasEvents,
    visits: hasSessions,
    clicks: hasTools,
    articleViews: hasInteractions, originalClicks: hasInteractions, feishuClicks: hasInteractions,
  };
}
type CountRow = { label: string; visits: bigint; visitors: bigint };
export async function getVisitAnalyticsReport(start: string, end: string, compare: CompareMode = 'previous') {
  const previousRange = comparisonRange(start, end, compare);
  const previousPromise = previousRange ? (async () => {
    const [pages, sessionCount, toolCount, interactions, firstSession] = await Promise.all([
      db.$queryRaw<Array<{ visitors: bigint; views: bigint | null }>>`SELECT COUNT(DISTINCT "visitorId") AS visitors, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS views FROM visit_events WHERE "dateKey" >= ${previousRange.start} AND "dateKey" <= ${previousRange.end}`,
      db.visitSession.count({ where: { dateKey: { gte: previousRange.start, lte: previousRange.end } } }),
      db.visitToolDaily.aggregate({ where: { dateKey: { gte: previousRange.start, lte: previousRange.end } }, _sum: { clicks: true } }),
      db.eventInteractionDaily.aggregate({ where: { dateKey: { gte: previousRange.start, lte: previousRange.end } }, _sum: { viewCount: true, originalClickCount: true, feishuClickCount: true } }),
      db.visitSession.findFirst({ orderBy: { dateKey: 'asc' }, select: { dateKey: true } }),
    ]);
    // 没有采集开始时间时，只把已有最早访问记录之后的区间用于参考对比。
    if (!firstSession || firstSession.dateKey > previousRange.start) return null;
    return {
      ...previousRange,
      visitors: numeric(pages[0]?.visitors ?? 0),
      views: numeric(pages[0]?.views ?? 0),
      visits: sessionCount,
      clicks: toolCount._sum.clicks ?? 0,
      articleViews: interactions._sum.viewCount ?? 0,
      originalClicks: interactions._sum.originalClickCount ?? 0,
      feishuClicks: interactions._sum.feishuClickCount ?? 0,
      available: metricAvailability(
        pages[0]?.views != null,
        sessionCount > 0,
        toolCount._sum.clicks != null,
        interactions._sum.viewCount != null || interactions._sum.originalClickCount != null || interactions._sum.feishuClickCount != null,
      ),
    };
  })() : Promise.resolve(null);
  const [counts, daily, channels, regions, tools, articles, dailyArticles, dailyTools, previous] = await Promise.all([
    db.$queryRaw<Array<{ visitors: bigint; views: bigint; clicks: bigint }>>`SELECT COUNT(DISTINCT "visitorId") AS visitors, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS views, 0 AS clicks FROM visit_events WHERE "dateKey" >= ${start} AND "dateKey" <= ${end}`,
    db.$queryRaw<Array<{ day: string; visitors: bigint; views: bigint }>>`SELECT "dateKey" AS day, COUNT(DISTINCT "visitorId") AS visitors, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS views FROM visit_events WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY "dateKey" ORDER BY "dateKey"`,
    db.$queryRaw<CountRow[]>`SELECT channel AS label, COUNT(*) AS visits, COUNT(DISTINCT "visitorId") AS visitors FROM visit_sessions WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY channel ORDER BY visits DESC`,
    db.$queryRaw<CountRow[]>`SELECT region || ' / ' || city AS label, COUNT(*) AS visits, COUNT(DISTINCT "visitorId") AS visitors FROM visit_sessions WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY region, city ORDER BY visits DESC`,
    db.$queryRaw<Array<{ label: string; count: bigint }>>`SELECT MAX("toolName") AS label, SUM(clicks) AS count FROM visit_tool_daily WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY "toolId" ORDER BY count DESC`,
    db.eventInteractionDaily.groupBy({ by: ['eventId'], where: { dateKey: { gte: start, lte: end } }, _sum: { viewCount: true, originalClickCount: true } }),
    db.eventInteractionDaily.groupBy({ by: ['dateKey'], where: { dateKey: { gte: start, lte: end } }, _sum: { viewCount: true, originalClickCount: true, feishuClickCount: true } }),
    db.visitToolDaily.groupBy({ by: ['dateKey'], where: { dateKey: { gte: start, lte: end } }, _sum: { clicks: true } }),
    previousPromise,
  ]);
  const sessions = await db.visitSession.groupBy({ by: ['dateKey'], where: { dateKey: { gte: start, lte: end } }, _count: { _all: true } });
  const ranked = articles.filter((x) => (x._sum.viewCount ?? 0) > 0 || (x._sum.originalClickCount ?? 0) > 0)
    .sort((a, b) => (b._sum.viewCount ?? 0) - (a._sum.viewCount ?? 0)
      || (b._sum.originalClickCount ?? 0) - (a._sum.originalClickCount ?? 0)
      || b.eventId.localeCompare(a.eventId));
  const topViewedArticles: Array<{ id: string; title: string; viewCount: number; publishedAt: string | null; score: number; sourceName: string }> = [];
  for (let offset = 0; offset < ranked.length && topViewedArticles.length < 20; offset += 100) {
    const chunk = ranked.slice(offset, offset + 100);
    const events = await db.event.findMany({
      where: { id: { in: chunk.map((x) => x.eventId) }, representativeArticleId: { not: null } },
      select: { id: true, representativeArticle: { select: { id: true, title: true, publishedAt: true, score: true, source: { select: { name: true } } } } },
    });
    const lookup = new Map(events.map((event) => [event.id, event.representativeArticle]));
    for (const row of chunk) {
      if (topViewedArticles.length >= 20) break;
      const article = lookup.get(row.eventId);
      if (article) topViewedArticles.push({ id: article.id, title: article.title, viewCount: row._sum.viewCount ?? 0, publishedAt: article.publishedAt?.toISOString() ?? null, score: article.score, sourceName: article.source.name });
    }
  }
  const sessionDays = new Map(sessions.map((x) => [x.dateKey, x._count._all]));
  const dailyByDate = new Map(daily.map((row) => [row.day, row]));
  const articleDays = new Map(dailyArticles.map((row) => [row.dateKey, row._sum]));
  const toolDays = new Map(dailyTools.map((row) => [row.dateKey, row._sum.clicks ?? 0]));
  const days = [...new Set([...dailyByDate.keys(), ...sessionDays.keys(), ...articleDays.keys(), ...toolDays.keys()])].sort();
  const c = counts[0];
  const hasEvents = daily.length > 0;
  const hasSessions = sessions.length > 0;
  const hasTools = dailyTools.length > 0;
  const hasInteractions = dailyArticles.length > 0;
  return {
    geoConfigured: isVisitGeoConfigured(),
    compareMode: compare,
    generatedAt: new Date().toISOString(),
    available: metricAvailability(hasEvents, hasSessions, hasTools, hasInteractions),
    previous,
    visitors: numeric(c?.visitors ?? 0),
    views: numeric(c?.views ?? 0),
    clicks: tools.reduce((n, row) => n + numeric(row.count), 0),
    visits: sessions.reduce((n, s) => n + s._count._all, 0),
    articleViews: articles.reduce((n, row) => n + (row._sum.viewCount ?? 0), 0),
    originalClicks: articles.reduce((n, row) => n + (row._sum.originalClickCount ?? 0), 0),
    feishuClicks: dailyArticles.reduce((n, row) => n + (row._sum.feishuClickCount ?? 0), 0),
    daily: days.map((day) => {
      const interactions = articleDays.get(day);
      return {
        day,
        visitors: numeric(dailyByDate.get(day)?.visitors ?? 0),
        views: numeric(dailyByDate.get(day)?.views ?? 0),
        visits: sessionDays.get(day) ?? 0,
        articleViews: interactions?.viewCount ?? 0,
        originalClicks: interactions?.originalClickCount ?? 0,
        feishuClicks: interactions?.feishuClickCount ?? 0,
        clicks: toolDays.get(day) ?? 0,
        /** 每个指标当天是否有独立采集来源，供趋势图区分"无采集"与"真 0"。 */
        recorded: {
          visitors: dailyByDate.has(day),
          views: dailyByDate.has(day),
          visits: sessionDays.has(day),
          articleViews: Boolean(interactions && interactions.viewCount != null),
          originalClicks: Boolean(interactions && interactions.originalClickCount != null),
          feishuClicks: Boolean(interactions && interactions.feishuClickCount != null),
          clicks: toolDays.has(day),
        },
      };
    }),
    channels: channels.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })),
    regions: regions.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })),
    tools: tools.slice(0, 30).map((x) => ({ label: x.label, count: numeric(x.count) })),
    topViewedArticles,
  };
}
