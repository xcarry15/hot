import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * Starts the scheduler, which directly runs crawl/push jobs at the configured
 * cadence. There is no separate polling worker anymore — scheduler and API
 * routes call runJob() (src/lib/execution.ts) directly. 前端从 Job 表轮询快照。
 */
let developmentProxyConfigured = false;

function configureDevelopmentOutboundProxy(): void {
  if (process.env.NODE_ENV !== 'development' || developmentProxyConfigured) return;

  const hasProxy = Boolean(
    process.env.HTTP_PROXY
      || process.env.HTTPS_PROXY
      || process.env.http_proxy
      || process.env.https_proxy,
  );
  if (!hasProxy) return;

  // Node 原生 fetch 不会自动使用 HTTP(S)_PROXY；仅在本地开发时接管服务端出站请求。
  setGlobalDispatcher(new EnvHttpProxyAgent());
  developmentProxyConfigured = true;
  console.log('[instrumentation] Development outbound HTTP proxy enabled');
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    configureDevelopmentOutboundProxy();
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
