import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'visit-analytics-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${dir}/test.db` } } });
vi.mock('@/lib/db', () => ({ db }));
const { recordVisit, cleanupVisitAnalytics, classifyVisitChannel, validVisitRange, previousVisitRange } = await import('@/lib/visit-analytics-service');
const visitorId = 'cf9f99cc-bc24-4cc5-9db0-9b58e8e9470b';
const base = { visitorId, kind: 'page' as const, referrer: 'https://www.baidu.com/a?secret=x', host: 'hot.kfxz.cn', clientIp: '' };

beforeAll(async () => {
  const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261109120000_visit_analytics/migration.sql'), 'utf8');
  for (const statement of sql.split(';').map((v) => v.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  await db.$executeRawUnsafe('CREATE TABLE tool_directory_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, archivedAt DATETIME, href TEXT)');
  await db.$executeRawUnsafe("INSERT INTO tool_directory_items (id, name, status, href) VALUES ('t1', '工具甲', 'active', 'https://example.com')");
});
afterAll(async () => { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

describe('访问统计真实 SQLite 边界', () => {
  it('等长上期跨月正确，超出保留期时不伪造零值', () => {
    const now = new Date('2026-11-12T04:00:00Z');
    expect(previousVisitRange('2026-11-01', '2026-11-10', now)).toEqual({ start: '2026-10-22', end: '2026-10-31' });
    expect(previousVisitRange('2025-11-13', '2025-11-20', now)).toBeNull();
    expect(previousVisitRange('2026-02-30', '2026-03-01', now)).toBeNull();
  });
  it('30 分钟内沿用访问，超过后新建；跨上海日期的浏览归属当天', async () => {
    await recordVisit(base, new Date('2026-11-08T15:50:00Z'));
    await recordVisit(base, new Date('2026-11-08T16:05:00Z'));
    await recordVisit(base, new Date('2026-11-08T16:36:00Z'));
    const sessions = await db.visitSession.findMany({ orderBy: { startedAt: 'asc' } });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].dateKey).toBe('2026-11-08');
    expect(sessions[0].channel).toBe('搜索引擎');
    const events = await db.visitEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.map((x) => x.dateKey)).toEqual(['2026-11-08', '2026-11-09', '2026-11-09']);
  });
  it('只记录存在且启用的工具，并保存名称快照', async () => {
    await recordVisit({ ...base, kind: 'tool', toolId: 'missing' }, new Date('2026-11-08T16:37:00Z'));
    await recordVisit({ ...base, kind: 'tool', toolId: 't1' }, new Date('2026-11-08T16:38:00Z'));
    const rows = await db.visitToolDaily.findMany();
    expect(rows.map((e) => [e.toolName, e.clicks])).toEqual([['工具甲', 1]]);
    expect(await db.visitEvent.count({ where: { kind: 'tool' } })).toBe(0);
  });
  it('同一浏览器并发请求不会生成多个会话', async () => {
    const concurrent = { ...base, visitorId: '4b99548b-3737-4c73-86a4-d874229eaf01' };
    await Promise.all([recordVisit(concurrent, new Date('2026-11-08T16:40:00Z')), recordVisit(concurrent, new Date('2026-11-08T16:40:00Z'))]);
    expect(await db.visitSession.count({ where: { visitorId: concurrent.visitorId } })).toBe(1);
    expect(await db.visitEvent.count({ where: { visitorId: concurrent.visitorId } })).toBe(2);
  });
  it('保留期以外的数据清理；日期范围拒绝越界和无效日期', async () => {
    await cleanupVisitAnalytics(new Date('2027-11-10T04:00:00Z'));
    expect(await db.visitEvent.count()).toBe(0);
    expect(validVisitRange('2026-02-30', '2026-03-01', new Date('2026-03-01T00:00:00Z'))).toBe(false);
    expect(validVisitRange('2025-01-01', '2026-03-01', new Date('2026-03-01T00:00:00Z'))).toBe(false);
    expect(classifyVisitChannel('https://baidu.com.evil.example/', 'hot.kfxz.cn')).toBe('其他网站');
  });
});
