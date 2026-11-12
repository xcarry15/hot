import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ groupBy: vi.fn(), findMany: vi.fn(), queryRaw: vi.fn(), sessions: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw, eventInteractionDaily: { groupBy: mocks.groupBy }, event: { findMany: mocks.findMany }, visitSession: { groupBy: mocks.sessions } } }));
vi.mock('@/lib/visit-geolocation', () => ({ isVisitGeoConfigured: () => true }));
vi.mock('@/lib/visit-analytics-service', () => ({ validVisitRange: () => true }));
import { GET } from '@/app/api/visit-analytics/route';

it('排行榜按所选日期统计，跳过无代表事件并继续补足', async () => {
  mocks.queryRaw.mockResolvedValue([]);
  mocks.sessions.mockResolvedValue([{ dateKey: '2026-11-02', _count: { _all: 1 } }]);
  mocks.groupBy.mockResolvedValue(Array.from({ length: 102 }, (_, index) => ({ eventId: `e${index}`, _sum: { viewCount: 102 - index, originalClickCount: 0 } })));
  mocks.findMany.mockImplementation(async ({ where }) => where.id.in.filter((id: string) => id === 'e101').map((id: string) => ({ id, representativeArticle: { id: 'a1', title: '标题', publishedAt: null, score: 80, source: { name: '来源' } } })));
  const response = await GET(new Request('http://localhost/api/visit-analytics?start=2026-11-01&end=2026-11-10'));
  const result = await response.json();
  expect(mocks.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { dateKey: { gte: '2026-11-01', lte: '2026-11-10' } } }));
  expect(mocks.findMany).toHaveBeenCalledTimes(2);
  expect(result.topViewedArticles).toEqual([{ id: 'a1', title: '标题', publishedAt: null, score: 80, sourceName: '来源', viewCount: 1 }]);
  expect(result.articleViews).toBe(5253);
  expect(result.originalClicks).toBe(0);
  expect(result.daily).toEqual([{ day: '2026-11-02', visitors: 0, visits: 1, views: 0 }]);
});
