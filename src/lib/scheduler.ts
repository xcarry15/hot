/**
 * In-process scheduler — runs inside the Next.js server.
 *
 * Responsibilities:
 *   - Read settings on each tick.
 *   - Run crawl/push jobs directly via runJob() when it's time.
 *
 * State is persisted via the Setting table instead of globalThis, so restarts
 * and multi-instance deployments don't lose scheduling context.
 */

import nodeCron from 'node-cron';
import { runJob, resetOrphanedJobs } from './execution';
import { getSetting, setSetting, readAllSettings, SETTING_KEYS } from './settings';
import { parsePushMode } from '@/contracts/push';

// HMR-safe guard: only start one scheduler per process. State itself is persisted in DB.
declare global {
  var __newsSchedulerStarted: boolean | undefined;
}

const LAST_CRAWL_AT_KEY = SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT;
const LAST_PUSH_DATE_KEY = SETTING_KEYS.SCHEDULER_LAST_PUSH_DATE;
let pushTask: ReturnType<typeof nodeCron.schedule> | null = null;
let pushTaskKey = '';

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

  const intervalMs = Math.max(5, parseInt(settings[SETTING_KEYS.CRAWL_INTERVAL_MIN] || '120', 10)) * 60 * 1000;
  const lastCrawlAtStr = await getSetting(LAST_CRAWL_AT_KEY);
  const lastCrawlAt = lastCrawlAtStr ? parseInt(lastCrawlAtStr, 10) : 0;

  if (Date.now() - lastCrawlAt < intervalMs) return;

  const res = await runJob('full');
  if (res.queued) {
    await setSetting(LAST_CRAWL_AT_KEY, String(Date.now()));
    console.log('[scheduler] started full-pipeline job', res.jobId);
  }
}

// 暴露给测试:scheduler 内部不导出其他启动逻辑,只把"是否入队 full job"这个
// 决策函数提出来。生产代码仍通过 startScheduler 内部的 cron tick 调用。
export { maybeEnqueueCrawl };

function syncPushSchedule(settings: Record<string, string>): void {
  const pushMode = parsePushMode(settings[SETTING_KEYS.PUSH_MODE]);
  const pushTime = settings[SETTING_KEYS.PUSH_TIME] || '08:30';
  const pushCron = toCronExpression(pushTime);
  const nextKey = pushMode === 'batch' && pushCron ? `${pushMode}:${pushCron}` : 'off';

  if (nextKey === pushTaskKey) return;

  pushTask?.stop();
  pushTask = null;
  pushTaskKey = nextKey;

  if (pushMode !== 'batch' || !pushCron) return;

  if (!nodeCron.validate(pushCron)) return;

  pushTask = nodeCron.schedule(pushCron, async () => {
    try {
      const today = new Date().toDateString();
      const lastPushDate = await getSetting(LAST_PUSH_DATE_KEY);
      if (lastPushDate === today) return;

      const res = await runJob('push');
      if (res.queued) {
        await setSetting(LAST_PUSH_DATE_KEY, today);
        console.log('[scheduler] started push job', res.jobId);
      }
    } catch (err) {
      console.error('[scheduler] push tick failed:', err instanceof Error ? err.message : err);
    }
  });

  console.log(`[scheduler] push scheduled at ${pushTime} (cron: ${pushCron})`);
}

/**
 * Start the scheduler. Safe to call multiple times (idempotent).
 *
 * Crawl: uses a 1-minute tick with interval-based check (from settings).
 * Push: uses node-cron's native cron scheduling (no manual cron matching).
 * Both run jobs via runJob() (src/lib/execution.ts). No separate polling
 * worker — jobs execute in-process so SSE progress events reach the browser.
 */
export function startScheduler(): void {
  if (globalThis.__newsSchedulerStarted) return;
  globalThis.__newsSchedulerStarted = true;

  if (nodeCron.validate('* * * * *') === false) return;

  // Reset orphaned 'running' jobs left by a previous process crash / HMR.
  void resetOrphanedJobs();

  // Crawl: 1-minute tick with interval check
  nodeCron.schedule('* * * * *', async () => {
    try {
      const settings = await readAllSettings();
      await maybeEnqueueCrawl(settings);
      syncPushSchedule(settings);
    } catch (err) {
      console.error('[scheduler] crawl tick failed:', err instanceof Error ? err.message : err);
    }
  });

  // Push: node-cron native scheduling, synchronized when settings change.
  readAllSettings().then(settings => syncPushSchedule(settings));

  console.log('🕐 Scheduler started (direct execution mode)');
  console.log('  - Crawl interval: reads from settings.crawl_interval_min (default 120 min)');
  console.log('  - Push time: reads from settings.push_time (default 08:30)');
  console.log('  - Auto-crawl switch: reads from settings.auto_crawl_enabled (default off)');
}
