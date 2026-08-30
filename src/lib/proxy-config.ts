import { db } from '@/lib/db';
import { proxyUrlSchema } from '@/contracts/proxy';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { decryptSensitiveSetting } from '@/lib/settings-crypto';

const PROXY_CACHE_TTL_MS = 5_000;
let cachedProxyUrl: string | undefined;
let cachedAt = 0;
let loadingProxy: Promise<string | undefined> | null = null;

/**
 * 读取全局出站代理。数据库中只要存在设置记录就以设置页为准，空值明确表示直连；
 * 环境变量只作为从未配置过时的迁移/启动兜底；
 * WINSHANG_PROXY_URL 是此前的临时配置名，保留兼容以免升级后立即失效。
 */
export async function getGlobalProxyUrl(): Promise<string | undefined> {
  if (process.env.NODE_ENV === 'test') return getEnvironmentProxyUrl();

  const now = Date.now();
  if (now - cachedAt < PROXY_CACHE_TTL_MS) return cachedProxyUrl;
  if (!loadingProxy) {
    loadingProxy = db.setting.findUnique({
      where: { key: SETTING_KEYS.OUTBOUND_PROXY_URL },
      select: { value: true },
    })
      .then((row) => row
        ? normalizeProxyUrl(row.value.trim() ? decryptSensitiveSetting(row.value) : undefined)
        : getEnvironmentProxyUrl())
      .then((value) => {
        cachedProxyUrl = value;
        cachedAt = Date.now();
        return value;
      })
      .finally(() => {
        loadingProxy = null;
      });
  }
  return loadingProxy;
}

export function invalidateGlobalProxyCache(): void {
  cachedProxyUrl = undefined;
  cachedAt = 0;
}

function getEnvironmentProxyUrl(): string | undefined {
  const value = process.env.OUTBOUND_PROXY_URL?.trim() || process.env.WINSHANG_PROXY_URL?.trim();
  return normalizeProxyUrl(value);
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const parsed = proxyUrlSchema.safeParse(value || '');
  return parsed.success && parsed.data ? parsed.data : undefined;
}
