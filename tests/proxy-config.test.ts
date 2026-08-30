import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { setting: { findUnique: mocks.findUnique } },
}));

vi.mock('@/lib/settings-crypto', () => ({
  decryptSensitiveSetting: (value: string) => value === 'encrypted-proxy' ? 'http://saved.example:8080' : value,
}));

import { getGlobalProxyUrl, invalidateGlobalProxyCache } from '@/lib/proxy-config';

afterEach(() => {
  invalidateGlobalProxyCache();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('全局代理配置读取', () => {
  it('没有数据库配置时使用环境变量兜底', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OUTBOUND_PROXY_URL', 'http://env.example:8080');
    mocks.findUnique.mockResolvedValue(null);

    await expect(getGlobalProxyUrl()).resolves.toBe('http://env.example:8080');
  });

  it('数据库空值明确关闭代理，不回退到环境变量', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OUTBOUND_PROXY_URL', 'http://env.example:8080');
    mocks.findUnique.mockResolvedValue({ value: '' });

    await expect(getGlobalProxyUrl()).resolves.toBeUndefined();
  });

  it('读取并解密数据库中的代理地址', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mocks.findUnique.mockResolvedValue({ value: 'encrypted-proxy' });

    await expect(getGlobalProxyUrl()).resolves.toBe('http://saved.example:8080');
  });

  it('忽略无效的环境变量代理，避免启动后每次请求崩溃', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OUTBOUND_PROXY_URL', 'not-a-proxy-url');
    mocks.findUnique.mockResolvedValue(null);

    await expect(getGlobalProxyUrl()).resolves.toBeUndefined();
  });
});
