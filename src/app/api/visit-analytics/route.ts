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
    db.eventInteractionDaily.groupBy({ by: ['eventId'], where: { dateKey: { gte: start, lte: end } }, _sum: { viewCount: true }, orderBy: { _sum: { viewCount: 'desc' } }, take: 30 }),
  ]);
  const sessions = await db.visitSession.groupBy({ by: ['dateKey'], where: { dateKey: { gte: start, lte: end } }, _count: { _all: true } });
  const events = await db.event.findMany({ where: { id: { in: articles.map((x) => x.eventId) } }, select: { id: true, representativeArticle: { select: { title: true } }, articles: { select: { title: true }, orderBy: { createdAt: 'asc' }, take: 1 }, publicStatus: true } });
  const lookup = new Map(events.map((x) => [x.id, x]));
  const sessionDays = new Map(sessions.map((x) => [x.dateKey, x._count._all]));
  const c = counts[0];
  return NextResponse.json({ geoConfigured: isVisitGeoConfigured(), visitors: numeric(c?.visitors ?? 0), views: numeric(c?.views ?? 0), clicks: tools.reduce((n, row) => n + numeric(row.count), 0), visits: sessions.reduce((n, s) => n + s._count._all, 0), daily: daily.map((x) => ({ day: x.day, visitors: numeric(x.visitors), views: numeric(x.views), visits: sessionDays.get(x.day) ?? 0 })), channels: channels.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })), regions: regions.map((x) => ({ label: x.label, visits: numeric(x.visits), visitors: numeric(x.visitors) })), tools: tools.slice(0, 30).map((x) => ({ label: x.label, count: numeric(x.count) })), articles: articles.map((x) => ({ label: lookup.get(x.eventId)?.representativeArticle?.title ?? lookup.get(x.eventId)?.articles[0]?.title ?? '历史资讯（标题不可用）', count: x._sum.viewCount ?? 0, status: lookup.get(x.eventId)?.publicStatus ?? '' })) });
}
