import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ groupBy: vi.fn(), findMany: vi.fn(), queryRaw: vi.fn(), sessions: vi.fn(), firstSession: vi.fn(), count: vi.fn(), toolAggregate: vi.fn(), toolGroup: vi.fn(), interactionAggregate: vi.fn(), previousRange: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw, eventInteractionDaily: { groupBy: mocks.groupBy, aggregate: mocks.interactionAggregate }, event: { findMany: mocks.findMany }, visitSession: { groupBy: mocks.sessions, count: mocks.count, findFirst: mocks.firstSession }, visitToolDaily: { aggregate: mocks.toolAggregate, groupBy: mocks.toolGroup } } }));
vi.mock('@/lib/visit-geolocation', () => ({ isVisitGeoConfigured: () => true }));
vi.mock('@/lib/visit-analytics-service', () => ({ validVisitRange: () => true, previousVisitRange: mocks.previousRange }));
import { GET } from '@/app/api/visit-analytics/route';

it('排行榜按所选日期统计，跳过无代表事件并继续补足', async () => {
  mocks.previousRange.mockReturnValue(null);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessions.mockResolvedValue([{ dateKey: '2026-11-02', _count: { _all: 1 } }]);
  mocks.groupBy.mockImplementation(async ({ by }) => by[0] === 'eventId' ? Array.from({ length: 102 }, (_, index) => ({ eventId: `e${index}`, _sum: { viewCount: 102 - index, originalClickCount: 0 } })) : [{ dateKey: '2026-11-03', _sum: { viewCount: 4, originalClickCount: 2 } }]);
  mocks.toolGroup.mockResolvedValue([{ dateKey: '2026-11-04', _sum: { clicks: 3 } }]);
  mocks.findMany.mockImplementation(async ({ where }) => where.id.in.filter((id: string) => id === 'e101').map((id: string) => ({ id, representativeArticle: { id: 'a1', title: '标题', publishedAt: null, score: 80, source: { name: '来源' } } })));
  const response = await GET(new Request('http://localhost/api/visit-analytics?start=2026-11-01&end=2026-11-10'));
  const result = await response.json();
  expect(mocks.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { dateKey: { gte: '2026-11-01', lte: '2026-11-10' } } }));
  expect(mocks.findMany).toHaveBeenCalledTimes(2);
  expect(result.topViewedArticles).toEqual([{ id: 'a1', title: '标题', publishedAt: null, score: 80, sourceName: '来源', viewCount: 1 }]);
  expect(result.articleViews).toBe(5253);
  expect(result.originalClicks).toBe(0);
  expect(result.daily).toEqual([{ day: '2026-11-02', visitors: 0, visits: 1, views: 0, articleViews: 0, originalClicks: 0, clicks: 0 }, { day: '2026-11-03', visitors: 0, visits: 0, views: 0, articleViews: 4, originalClicks: 2, clicks: 0 }, { day: '2026-11-04', visitors: 0, visits: 0, views: 0, articleViews: 0, originalClicks: 0, clicks: 3 }]);
});

it('等长上期分别读取独立访客、访问、工具和资讯汇总', async () => {
  mocks.previousRange.mockReturnValue({ start: '2026-10-22', end: '2026-10-31' });
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessions.mockResolvedValue([]);
  mocks.groupBy.mockResolvedValue([]);
  mocks.toolGroup.mockResolvedValue([]);
  mocks.count.mockResolvedValue(6);
  mocks.firstSession.mockResolvedValue({ dateKey: '2026-10-01' });
  mocks.toolAggregate.mockResolvedValue({ _sum: { clicks: 4 } });
  mocks.interactionAggregate.mockResolvedValue({ _sum: { viewCount: 8, originalClickCount: 3 } });
  const response = await GET(new Request('http://localhost/api/visit-analytics?start=2026-11-01&end=2026-11-10'));
  const result = await response.json();
  expect(result.previous).toEqual({ start: '2026-10-22', end: '2026-10-31', visitors: 0, views: 0, visits: 6, clicks: 4, articleViews: 8, originalClicks: 3 });
  expect(mocks.count).toHaveBeenCalledWith({ where: { dateKey: { gte: '2026-10-22', lte: '2026-10-31' } } });
  mocks.firstSession.mockResolvedValue({ dateKey: '2026-10-23' });
  expect((await (await GET(new Request('http://localhost/api/visit-analytics?start=2026-11-01&end=2026-11-10'))).json()).previous).toBeNull();
});
