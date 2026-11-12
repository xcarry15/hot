import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isVisitGeoConfigured } from '@/lib/visit-geolocation';
import { validVisitRange } from '@/lib/visit-analytics-service';

const numeric = (v: bigint | number) => Number(v);
type CountRow = { label: string; visits: bigint; visitors: bigint };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const start = params.get('start') || '';
  const end = params.get('end') || '';
  if (!validVisitRange(start, end)) return NextResponse.json({ error: '日期范围无效' }, { status: 400 });
  const [counts, daily, channels, regions, tools, articles] = await Promise.all([
    db.$queryRaw<Array<{ visitors: bigint; views: bigint; clicks: bigint }>>`SELECT COUNT(DISTINCT "visitorId") AS visitors, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS views, 0 AS clicks FROM visit_events WHERE "dateKey" >= ${start} AND "dateKey" <= ${end}`,
    db.$queryRaw<Array<{ day: string; visitors: bigint; views: bigint }>>`SELECT "dateKey" AS day, COUNT(DISTINCT "visitorId") AS visitors, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS views FROM visit_events WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY "dateKey" ORDER BY "dateKey"`,
    db.$queryRaw<CountRow[]>`SELECT channel AS label, COUNT(*) AS visits, COUNT(DISTINCT "visitorId") AS visitors FROM visit_sessions WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY channel ORDER BY visits DESC`,
    db.$queryRaw<CountRow[]>`SELECT region || ' / ' || city AS label, COUNT(*) AS visits, COUNT(DISTINCT "visitorId") AS visitors FROM visit_sessions WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY region, city ORDER BY visits DESC`,
    db.$queryRaw<Array<{ label: string; count: bigint }>>`SELECT MAX("toolName") AS label, SUM(clicks) AS count FROM visit_tool_daily WHERE "dateKey" >= ${start} AND "dateKey" <= ${end} GROUP BY "toolId" ORDER BY count DESC`,
    db.eventInteractionDaily.groupBy({ by: ['eventId'], where: { dateKey: { gte: start, lte: end } }, _sum: { viewCount: true, originalClickCount: true } }),
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
  const days = [...new Set([...dailyByDate.keys(), ...sessionDays.keys()])].sort();
  const c = counts[0];
  return NextResponse.json({ geoConfigured: isVisitGeoConfigured(), visitors: numeric(c?.visitors ?? 0), views: numeric(c?.views ?? 0), clicks: tools.reduce((n, row) => n + numeric(row.count), 0), visits: sessions.reduce((n, s) => n + s._count._all, 0), articleViews: articles.reduce((n, row) => n + (row._sum.viewCount ?? 0), 0), originalClicks: articles.reduce((n, row) => n + (row._sum.originalClickCount ?? 0), 0), daily: days.map((day) => ({ day, visitors: numeric(dailyByDate.get(day)?.visitors ?? 0), views: numeric(dailyByDate.get(day)?.views ?? 0), visits: sessionDays.get(day) ?? 0 })), channels: channels.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })), regions: regions.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })), tools: tools.slice(0, 30).map((x) => ({ label: x.label, count: numeric(x.count) })), topViewedArticles });
}
