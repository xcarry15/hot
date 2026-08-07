/**
 * In-process scheduler — runs inside the Next.js server.
 *
 * Responsibilities:
 *   - Read settings on each tick.
 *   - Run crawl/push jobs directly via runJob() when due.
 *
 * State is persisted via the Setting table instead of globalThis, so restarts
 * and multi-instance deployments don't lose scheduling context.
 */

import nodeCron from 'node-cron';
import { runJob, resetOrphanedJobs, resumeQueuedJob } from './execution';
import { getSetting, setSetting, readAllSettings, SETTING_KEYS } from './settings';
import { parsePushMode } from '@/contracts/push';
import { db } from './db';
import { pushableWhere, readPushSettings } from './push/policy';
import { cleanupExpiredSendingDeliveries } from './push/delivery';
import { hasDueTechnicalRecovery } from './technical-work-queue-service';
import { hasDirtyEvents } from './event/event-consistency-service';
import { hasPendingSettingsRebuild } from './settings-rebuild-service';
import { cleanupExpiredExportJobs, startExportWorker } from './export/export-service';
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  isWithinQuietHours,
  parseTimeOfDay,
  SCHEDULER_TIME_ZONE,
} from './quiet-hours';

// HMR-safe guard: only start one scheduler per process. State itself is persisted in DB.
declare global {
  var __newsSchedulerStarted: boolean | undefined;
}

const LAST_CRAWL_AT_KEY = SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT;
const LAST_PUSH_DATE_KEY = SETTING_KEYS.SCHEDULER_LAST_PUSH_DATE;
const PUSH_JOB_MARKER_KEY = SETTING_KEYS.SCHEDULER_PUSH_JOB || 'scheduler_push_job';
let pushTask: ReturnType<typeof nodeCron.schedule> | null = null;
let pushTaskKey = '';
let schedulerTickPromise: Promise<void> | null = null;

interface ZonedClock {
  date: string;
  minute: number;
  minuteKey: string;
}

interface PushJobMarker {
  date: string;
  jobId: string;
}

function getZonedClock(now = new Date()): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULER_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return {
    date,
    minute: hour * 60 + minute,
    minuteKey: `${date}T${values.hour}:${values.minute}`,
  };
}

/** 推送时间若落在免打扰时段，顺延到免打扰结束，避免整天永远错过。 */
function getEffectivePushTimeMinutes(
  pushTime: string,
  quietStart: string | undefined,
  quietEnd: string | undefined,
): number | null {
  const configured = parseTimeOfDay(pushTime);
  const start = parseTimeOfDay(quietStart);
  const end = parseTimeOfDay(quietEnd);
  if (configured === null || start === null || end === null || start === end) return configured;
  const inQuiet = start < end
    ? configured >= start && configured < end
    : configured >= start || configured < end;
  return inQuiet ? end : configured;
}

function isQuietHoursNow(settings: Record<string, string>, now = new Date()): boolean {
  return isWithinQuietHours(
    now,
    settings[SETTING_KEYS.CRAWL_QUIET_START] || DEFAULT_QUIET_START,
    settings[SETTING_KEYS.CRAWL_QUIET_END] || DEFAULT_QUIET_END,
    SCHEDULER_TIME_ZONE,
  );
}

function parsePushJobMarker(raw: string | null): PushJobMarker | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PushJobMarker>;
    if (typeof value.date !== 'string' || typeof value.jobId !== 'string' || !value.jobId) return null;
    return { date: value.date, jobId: value.jobId };
  } catch {
    return null;
  }
}

function serializePushJobMarker(marker: PushJobMarker): string {
  return JSON.stringify(marker);
}

async function findLatestPushJob(idempotencyKey: string) {
  return db.job.findFirst({
    where: { idempotencyKey },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}

/**
 * 结算持久化的批量推送 Job。LAST_PUSH_DATE 只在 Job 真正 succeeded 后写入，
 * 因而调度器在“采集任务占用执行权”或进程重启时不会把整天推送标记成已完成。
 */
async function settlePushJobMarker(marker: PushJobMarker): Promise<'active' | 'completed' | 'retry'> {
  const job = await db.job.findUnique({ where: { id: marker.jobId }, select: { status: true } });
  if (!job) {
    await setSetting(PUSH_JOB_MARKER_KEY, '');
    return 'retry';
  }
  if (job.status === 'succeeded' || job.status === 'completed') {
    await setSetting(LAST_PUSH_DATE_KEY, marker.date);
    await setSetting(PUSH_JOB_MARKER_KEY, '');
    return 'completed';
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    await setSetting(PUSH_JOB_MARKER_KEY, '');
    return 'retry';
  }
  return 'active';
}

async function hasDuePushEvent(settings?: Awaited<ReturnType<typeof readPushSettings>>): Promise<boolean> {
  const effectiveSettings = settings ?? await readPushSettings();
  const event = await db.event.findFirst({
    where: pushableWhere(effectiveSettings),
    select: { id: true },
  });
  return Boolean(event);
}

async function hasDueBatchEvent(): Promise<boolean> {
  const settings = await readPushSettings();
  if (settings.pushMode !== 'batch') return false;
  return hasDuePushEvent(settings);
}

/**
 * 每分钟检查一次批量推送，而不是只依赖配置时间点的 cron 回调：
 * - 配置时间点被其他 Job 占用时，后续 tick 会补偿；
 * - Event 的 6 小时 nextPushRetryAt 到期后，后续 tick 会触发重试；
 * - 只有 Job succeeded（终态完成）才会写入每日完成标记。
 */
export async function maybeEnqueueBatchPush(settings: Record<string, string>): Promise<void> {
  if (parsePushMode(settings[SETTING_KEYS.PUSH_MODE]) !== 'batch') return;

  const clock = getZonedClock();
  const marker = parsePushJobMarker(await getSetting(PUSH_JOB_MARKER_KEY));
  if (marker) {
    const state = await settlePushJobMarker(marker);
    if (state === 'active') return;
  }

  // 先结算已结束 Job，再挡住新任务；否则跨过免打扰时段时可能遗留 marker。
  if (isQuietHoursNow(settings, new Date())) return;

  const lastPushDate = await getSetting(LAST_PUSH_DATE_KEY);
  const effectivePushTime = getEffectivePushTimeMinutes(
    settings[SETTING_KEYS.PUSH_TIME] || '08:30',
    settings[SETTING_KEYS.CRAWL_QUIET_START] || DEFAULT_QUIET_START,
    settings[SETTING_KEYS.CRAWL_QUIET_END] || DEFAULT_QUIET_END,
  );
  const initialDue = lastPushDate !== clock.date
    && effectivePushTime !== null
    && clock.minute >= effectivePushTime;
  const retryDue = lastPushDate === clock.date && await hasDueBatchEvent();
  if (!initialDue && !retryDue) return;

  const idempotencyKey = initialDue
    ? `daily-push:${clock.date}`
    : `batch-push-retry:${clock.minuteKey}`;

  // 进程重启或 marker 写入失败后，先从 Job 表恢复当天已存在的任务，避免重复创建。
  if (initialDue) {
    const existing = await findLatestPushJob(idempotencyKey);
    if (existing?.status === 'succeeded' || existing?.status === 'completed') {
      await setSetting(LAST_PUSH_DATE_KEY, clock.date);
      return;
    }
    if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
      await setSetting(PUSH_JOB_MARKER_KEY, serializePushJobMarker({ date: clock.date, jobId: existing.id }));
      return;
    }
  }

  const result = await runJob('push', {
    trigger: initialDue ? 'auto' : 'auto_retry',
    idempotencyKey,
  });
  if (result.queued) {
    await setSetting(PUSH_JOB_MARKER_KEY, serializePushJobMarker({ date: clock.date, jobId: result.jobId }));
    console.log(`[scheduler] started ${initialDue ? 'daily' : 'retry'} push job`, result.jobId);
  }
}

/** realtime 流程若在免打扰开始前启动、但推送阶段在时段内被跳过，离开时段后补发。 */
export async function maybeEnqueueRealtimePush(settings: Record<string, string>): Promise<void> {
  if (parsePushMode(settings[SETTING_KEYS.PUSH_MODE]) !== 'realtime') return;
  if (isQuietHoursNow(settings, new Date())) return;
  const pushSettings = await readPushSettings();
  if (pushSettings.pushMode !== 'realtime' || !await hasDuePushEvent(pushSettings)) return;

  const clock = getZonedClock();
  const result = await runJob('push', {
    trigger: 'auto_retry',
    idempotencyKey: `realtime-push:${clock.minuteKey}`,
  });
  if (result.queued) console.log('[scheduler] started deferred realtime push job', result.jobId);
}

/** 把每日 HH:mm 配置转换成 node-cron 表达式。 */
function toCronExpression(pushTime: string): string | null {
  const trimmed = (pushTime || '').trim();
  const m = trimmed.match(/^(\d{2}):(\d{2})$/);
  if (m) {
    const H = parseInt(m[1], 10);
    const M = parseInt(m[2], 10);
    if (H >= 0 && H <= 23 && M >= 0 && M <= 59) {
      return `${M} ${H} * * *`;
    }
  }
  return null;
}

async function maybeEnqueueCrawl(settings: Record<string, string>): Promise<void> {
  // 配置缺失也按关闭处理：新安装与迁移中的数据库不能意外自动抓取。
  if (settings[SETTING_KEYS.AUTO_CRAWL_ENABLED] !== 'true') return;
  if (isQuietHoursNow(settings, new Date())) return;

  // 设置写入有校验，但数据库可能因手工维护或旧数据出现异常值。不能让 NaN
  // 绕过间隔判断、每分钟重复创建抓取任务；与工作台运行态使用同一默认值。
  const configuredInterval = Number.parseInt(settings[SETTING_KEYS.CRAWL_INTERVAL_MIN] || '120', 10);
  const intervalMinutes = Number.isFinite(configuredInterval)
    ? Math.max(5, configuredInterval)
    : 120;
  const intervalMs = intervalMinutes * 60 * 1000;
  const lastCrawlAtStr = await getSetting(LAST_CRAWL_AT_KEY);
  const lastCrawlAt = lastCrawlAtStr ? parseInt(lastCrawlAtStr, 10) : 0;

  if (Date.now() - lastCrawlAt < intervalMs) return;

  const res = await runJob('full', { trigger: 'auto' });
  if (res.queued) {
    await setSetting(LAST_CRAWL_AT_KEY, String(Date.now()));
    console.log('[scheduler] started full-pipeline job', res.jobId);
  }
}

/**
 * 技术失败恢复独立于自动采集开关：只处理已有 Article，不重新请求数据源。
 */
async function maybeEnqueueTechnicalRetry(settings?: Record<string, string>): Promise<void> {
  const effectiveSettings = settings ?? await readAllSettings();
  if (isQuietHoursNow(effectiveSettings, new Date())) return;
  const [hasTechnicalRecovery, hasEventRepair] = await Promise.all([
    hasDueTechnicalRecovery(),
    hasDirtyEvents(),
  ]);
  if (!hasTechnicalRecovery && !hasEventRepair) return;

  const res = await runJob(hasTechnicalRecovery ? 'full' : 'cluster', {
    trigger: 'auto_retry',
    ...(hasTechnicalRecovery ? { skipCollect: true } : { repairOnly: true }),
  });
  if (res.queued) {
    console.log(`[scheduler] started ${hasTechnicalRecovery ? 'technical' : 'Event'} recovery job`, res.jobId);
  }
}

/** 设置保存后的大批派生状态同步。标记由设置短事务写入，任务繁忙时保留到下次 tick。 */
async function maybeEnqueueSettingsRebuild(): Promise<void> {
  if (!await hasPendingSettingsRebuild()) return;
  const res = await runJob('full', {
    trigger: 'settings-rebuild',
    skipCollect: true,
    settingsRebuild: true,
  });
  if (res.queued) console.log('[scheduler] started pending settings rebuild', res.jobId);
}

// 暴露给测试:scheduler 内部不导出其他启动逻辑,只把"是否入队 full job"这个
// 决策函数提出来。生产代码仍通过 startScheduler 内部的 cron tick 调用。
export { maybeEnqueueCrawl, maybeEnqueueTechnicalRetry, maybeEnqueueSettingsRebuild };

/** 每分钟的持久化恢复与调度检查；独立导出便于回归测试。 */
export function runSchedulerTick(): Promise<void> {
  if (schedulerTickPromise) return schedulerTickPromise;
  const promise = runSchedulerTickInternal();
  schedulerTickPromise = promise;
  void promise.then(
    () => { if (schedulerTickPromise === promise) schedulerTickPromise = null; },
    () => { if (schedulerTickPromise === promise) schedulerTickPromise = null; },
  );
  return promise;
}

async function runSchedulerTickInternal(): Promise<void> {
  // 先恢复持久化队列，再决定是否创建新的自动任务；避免失败 Job 被新任务长期挤压。
  await resetOrphanedJobs();
  await resumeQueuedJob();
  // sending 租约到期后结果无法确定，必须及时转为人工确认，不能只等进程重启。
  await cleanupExpiredSendingDeliveries();
  await cleanupExpiredExportJobs();
  startExportWorker();
  const settings = await readAllSettings();
  await maybeEnqueueSettingsRebuild();
  await maybeEnqueueCrawl(settings);
  await maybeEnqueueBatchPush(settings);
  await maybeEnqueueRealtimePush(settings);
  await maybeEnqueueTechnicalRetry(settings);
  syncPushSchedule(settings);
}

function syncPushSchedule(settings: Record<string, string>): void {
  const pushMode = parsePushMode(settings[SETTING_KEYS.PUSH_MODE]);
  const configuredPushTime = settings[SETTING_KEYS.PUSH_TIME] || '08:30';
  // 兼容历史版本遗留的 cron: 值；新版本只允许每日固定时间。
  const pushTime = toCronExpression(configuredPushTime) ? configuredPushTime : '08:30';
  const pushCron = toCronExpression(pushTime);
  const nextKey = pushMode === 'batch' && pushCron ? `${pushMode}:${pushCron}` : 'off';

  if (nextKey === pushTaskKey) return;

  // 批量推送由每分钟的 runSchedulerTick 统一驱动。保留 pushTask 的 stop 逻辑，
  // 以便热更新时终止旧版本留下的定时器，但不再在精确时间点直接写“已完成”。
  pushTask?.stop();
  pushTask = null;
  pushTaskKey = nextKey;

  if (pushMode === 'batch' && pushCron && nodeCron.validate(pushCron)) {
    console.log(`[scheduler] push catch-up enabled at ${pushTime} (cron: ${pushCron})`);
  }
}

/**
 * Start the scheduler. Safe to call multiple times (idempotent).
 *
 * Crawl: uses a 1-minute tick with interval-based check (from settings).
 * Push: uses the minute tick with a durable daily marker and retry catch-up.
 * Both run jobs via runJob() (src/lib/execution.ts). No separate polling
 * worker — jobs execute in-process so SSE progress events reach the browser.
 */
export function startScheduler(): void {
  if (globalThis.__newsSchedulerStarted) return;
  globalThis.__newsSchedulerStarted = true;

  if (nodeCron.validate('* * * * *') === false) return;

  // Reset orphaned 'running' jobs left by a previous process crash / HMR.
  void resetOrphanedJobs().then(() => resumeQueuedJob());
  // 启动即先清理一次；之后由每分钟 tick 持续清理。
  void cleanupExpiredSendingDeliveries().catch((error) => {
    console.error('[scheduler] initial delivery cleanup failed:', error);
  });
  void cleanupExpiredExportJobs().catch((error) => {
    console.error('[scheduler] initial export cleanup failed:', error);
  });
  startExportWorker();

  // Crawl: 1-minute tick with interval check
  nodeCron.schedule('* * * * *', async () => {
    try {
      await runSchedulerTick();
    } catch (err) {
      console.error('[scheduler] crawl tick failed:', err instanceof Error ? err.message : err);
    }
  });

  // Push: minute-tick catch-up, synchronized when settings change.
  readAllSettings().then(settings => syncPushSchedule(settings));

  console.log('🕐 Scheduler started (direct execution mode)');
  console.log('  - Crawl interval: reads from settings.crawl_interval_min (default 120 min)');
  console.log('  - Push time: reads from settings.push_time (default 08:30)');
  console.log('  - Auto-crawl switch: reads from settings.auto_crawl_enabled (default off)');
  console.log('  - Technical recovery: checks due failed articles every minute');
}
