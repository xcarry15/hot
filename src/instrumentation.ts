/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * Starts the scheduler, which directly runs crawl/push jobs at the configured
 * cadence. There is no separate polling worker anymore — scheduler and API
 * routes call runJob() (src/lib/execution.ts) directly. 前端从 Job 表轮询快照。
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { initializeDatabaseRuntime } = await import('./lib/database-runtime');
      const database = await initializeDatabaseRuntime();
      if (database.journalMode !== 'wal') {
        console.warn(`[instrumentation] SQLite journal_mode=${database.journalMode}; expected wal`);
      } else {
        console.log(`[instrumentation] SQLite ready (wal, busy_timeout=${database.busyTimeout}ms)`);
      }
    } catch (error) {
      console.error('[instrumentation] SQLite runtime optimization failed; continuing startup', error);
    }
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
    console.log('[instrumentation] scheduler started (direct execution mode)');
  }
}
