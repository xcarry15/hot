/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * Starts the scheduler, which directly runs crawl/push jobs at the configured
 * cadence. There is no separate polling worker anymore — scheduler and API
 * routes call runJob() (src/lib/execution.ts) directly. 前端从 Job 表轮询快照。
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
    console.log('[instrumentation] scheduler started (direct execution mode)');
  }
}
