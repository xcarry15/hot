import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { isKnownUndiciAbortRace } from './lib/undici-abort-race';

let developmentProxyConfigured = false;
let undiciAbortRaceGuardConfigured = false;

function configureUndiciAbortRaceGuard(): void {
  if (undiciAbortRaceGuardConfigured) return;

  process.on('uncaughtException', (error) => {
    if (isKnownUndiciAbortRace(error)) {
      console.warn('[instrumentation] suppressed undici abort race', error.message);
      return;
    }
    throw error;
  });
  undiciAbortRaceGuardConfigured = true;
}

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

export async function registerNodeInstrumentation(): Promise<void> {
  configureUndiciAbortRaceGuard();
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
