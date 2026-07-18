import { db } from '@/lib/db';

const DASHBOARD_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
let lastDashboardCaptureAt = 0;
let dashboardCaptureInFlight: Promise<void> | null = null;

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

export function captureInboxSnapshotForDashboard(): Promise<void> {
  const now = Date.now();
  if (dashboardCaptureInFlight) return dashboardCaptureInFlight;
  if (now - lastDashboardCaptureAt < DASHBOARD_SNAPSHOT_MIN_INTERVAL_MS) return Promise.resolve();
  lastDashboardCaptureAt = now;
  const task = captureInboxSnapshot().finally(() => {
    if (dashboardCaptureInFlight === task) dashboardCaptureInFlight = null;
  });
  dashboardCaptureInFlight = task;
  return task;
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
