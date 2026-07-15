import { db } from '@/lib/db';

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export async function captureInboxSnapshot(): Promise<void> {
  const capturedOn = startOfToday();
  const pendingCount = await db.article.count({ where: { fetchStatus: 'fetched', reviewStatus: 'unreviewed' } });
  await db.inboxSnapshot.upsert({
    where: { capturedOn },
    update: { pendingCount },
    create: { capturedOn, pendingCount },
  });
  const keepFrom = new Date(capturedOn);
  keepFrom.setDate(keepFrom.getDate() - 90);
  await db.inboxSnapshot.deleteMany({ where: { capturedOn: { lt: keepFrom } } });
}

export async function listInboxSnapshots(days = 7) {
  const start = startOfToday();
  start.setDate(start.getDate() - Math.max(1, days - 1));
  return db.inboxSnapshot.findMany({
    where: { capturedOn: { gte: start } },
    orderBy: { capturedOn: 'asc' },
    select: { capturedOn: true, pendingCount: true },
  });
}
