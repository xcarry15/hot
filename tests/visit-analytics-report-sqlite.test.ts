import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getPublicDateKey } from '@/lib/shared/public-date';

const dir = mkdtempSync(path.join(tmpdir(), 'hot-visit-report-'));
const url = `file:${dir}/report.db`;
const db = new PrismaClient({ datasources: { db: { url } } });
vi.mock('@/lib/db', () => ({ db }));
const { GET } = await import('@/app/api/visit-analytics/route');

beforeAll(() => {
  execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000 });
}, 90_000);
afterAll(async () => { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

it('真实 SQLite 按自然日汇总本期与上期，跨日会话和仅工具点击日期不丢失', async () => {
  const day = (offset: number) => getPublicDateKey(Date.now() - offset * 86_400_000);
  await db.visitSession.createMany({ data: [
    { id: 'old', visitorId: 'v1', dateKey: day(3), startedAt: new Date(), lastAt: new Date(), region: '未知', city: '未知', channel: '直接访问' },
    { id: 'previous', visitorId: 'v1', dateKey: day(2), startedAt: new Date(), lastAt: new Date(), region: '未知', city: '未知', channel: '直接访问' },
    { id: 'current', visitorId: 'v2', dateKey: day(1), startedAt: new Date(), lastAt: new Date(), region: '未知', city: '未知', channel: '搜索引擎' },
  ] });
  await db.visitEvent.createMany({ data: [
    { id: 'p1', sessionId: 'previous', visitorId: 'v1', dateKey: day(2), kind: 'page' },
    { id: 'p2', sessionId: 'current', visitorId: 'v2', dateKey: day(0), kind: 'page' },
  ] });
  await db.visitToolDaily.create({ data: { dateKey: day(1), toolId: 't1', toolName: '工具', clicks: 3 } });
  const response = await GET(new Request(`http://localhost/api/visit-analytics?start=${day(1)}&end=${day(0)}`));
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({ visitors: 1, views: 1, visits: 1, clicks: 3, previous: { start: day(3), end: day(2), visitors: 1, views: 1, visits: 2, clicks: 0 } });
  expect(data.daily).toEqual([
    { day: day(1), visitors: 0, views: 0, visits: 1, clicks: 3, articleViews: 0, originalClicks: 0 },
    { day: day(0), visitors: 1, views: 1, visits: 0, clicks: 0, articleViews: 0, originalClicks: 0 },
  ]);
});
