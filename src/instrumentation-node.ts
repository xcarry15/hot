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
    // 不能在 uncaughtException 回调里再 throw：那会变成「监听器内未捕获异常」，
    // 进程仍崩溃且丢失原始堆栈与 context。记录完整错误后交回 Node 默认行为
    // （保留崩溃语义，但不二次抛出）。
    console.error('[instrumentation] uncaught exception (fatal):', error);
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
      // 只报告库级事实与初始化连接上的值，不再暗示「整库所有连接已配置」。
      console.log(
        `[instrumentation] SQLite ready (journal_mode=wal [database-wide]; ` +
        `bootstrap connection: busy_timeout=${database.busyTimeout}ms, synchronous=${database.synchronous}); ` +
        `connection-scoped PRAGMAs are re-applied per write transaction by sqlite-write-queue`,
      );
    }
  } catch (error) {
    console.error('[instrumentation] SQLite runtime optimization failed; continuing startup', error);
  }
  // P0-3 启动自检：现有 enc:v1 设置必须能用当前密钥解密，否则 fail-fast。
  // 生产库密钥错配时宁可不启动，也不要带着无法解密的 AI Key / Webhook 运行。
  // /api/health 的 settingsCryptoHealthy 标记由 health route 单独探测，状态码恒为 200。
  const { assertSettingsCryptoHealthy } = await import('./lib/settings-service');
  try {
    await assertSettingsCryptoHealthy();
  } catch (error) {
    console.error('[instrumentation] settings encryption self-check failed; aborting startup:', error);
    throw error;
  }
  const { startScheduler } = await import('./lib/scheduler');
  startScheduler();
  console.log('[instrumentation] scheduler started (direct execution mode)');
}
