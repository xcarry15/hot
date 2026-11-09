import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { lookupVisitRegion } from '@/lib/visit-geolocation';
import { getPublicDateKey } from '@/lib/shared/public-date';

const DAY = 86_400_000;
const RETENTION_DAYS = 365;
const SESSION_GAP = 30 * 60_000;

export function classifyVisitChannel(referrer: string, host: string): string {
  if (!referrer) return '直接访问';
  try {
    const url = new URL(referrer);
    if (!['http:', 'https:'].includes(url.protocol)) return '未知';
    const name = url.hostname.toLowerCase();
    if (name === host.toLowerCase().split(':')[0]) return '直接访问';
    if (/(^|\.)(baidu\.com|google\.com|bing\.com|so\.com|sogou\.com|sm\.cn)$/.test(name)) return '搜索引擎';
    return '其他网站';
  } catch { return '未知'; }
}

export async function recordVisit(input: { visitorId: string; kind: 'page' | 'tool'; toolId?: string; referrer: string; host: string; clientIp: string }, now = new Date()) {
  const dateKey = getPublicDateKey(now);
  const recent = await db.visitSession.findFirst({ where: { visitorId: input.visitorId, lastAt: { gte: new Date(now.getTime() - SESSION_GAP), lte: now } }, select: { id: true } });
  const location = recent ? { region: '未知', city: '未知' } : await lookupVisitRegion(input.clientIp);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
    let tool: { id: string; name: string } | null = null;
    if (input.kind === 'tool') {
      tool = await tx.toolDirectoryItem.findFirst({ where: { id: input.toolId, status: 'active', archivedAt: null, href: { not: null } }, select: { id: true, name: true } });
      if (!tool) return;
    }
    let session = await tx.visitSession.findFirst({ where: { visitorId: input.visitorId, lastAt: { gte: new Date(now.getTime() - SESSION_GAP), lte: now } }, orderBy: { lastAt: 'desc' } });
    if (!session) {
      session = await tx.visitSession.create({ data: { id: randomUUID(), visitorId: input.visitorId, startedAt: now, lastAt: now, dateKey, region: location.region, city: location.city, channel: classifyVisitChannel(input.referrer, input.host) } });
    } else {
      await tx.visitSession.update({ where: { id: session.id }, data: { lastAt: now } });
    }
    if (tool) {
      await tx.visitToolDaily.upsert({ where: { dateKey_toolId: { dateKey, toolId: tool.id } }, create: { dateKey, toolId: tool.id, toolName: tool.name, clicks: 1 }, update: { clicks: { increment: 1 }, toolName: tool.name } });
      return;
    }
    await tx.visitEvent.create({ data: { id: randomUUID(), sessionId: session.id, visitorId: input.visitorId, dateKey, kind: input.kind, createdAt: now } });
      });
    } catch (error) {
      if (attempt >= 2 || !/locked|busy|P1008|P2024|P2028/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 40));
    }
  }
}

export async function cleanupVisitAnalytics(now = new Date()) {
  const cutoff = getPublicDateKey(now.getTime() - (RETENTION_DAYS - 1) * DAY);
  await db.$transaction([
    db.visitToolDaily.deleteMany({ where: { dateKey: { lt: cutoff } } }),
    db.visitEvent.deleteMany({ where: { dateKey: { lt: cutoff } } }),
    db.visitSession.deleteMany({ where: { lastAt: { lt: new Date(now.getTime() - RETENTION_DAYS * DAY) } } }),
  ]);
}

export function validVisitRange(start: string, end: string, now = new Date()): boolean {
  const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  const today = getPublicDateKey(now);
  const oldest = getPublicDateKey(now.getTime() - (RETENTION_DAYS - 1) * DAY);
  return valid(start) && valid(end) && start >= oldest && end <= today && start <= end;
}
