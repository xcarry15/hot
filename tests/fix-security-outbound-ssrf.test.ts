import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsMock.lookup }));

import {
  assertSafeOutboundUrl,
  assertSafeProxyUrl,
  getOutboundProxyDispatcher,
  isBlockedOutboundHostname,
} from '@/lib/outbound-url';

describe('P1 安全专项：代理路径 SSRF 拦截', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    dnsMock.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4, ttl: 60 }]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('主机黑名单覆盖 localhost 与内网/元数据地址', () => {
    expect(isBlockedOutboundHostname('localhost')).toBe(true);
    expect(isBlockedOutboundHostname('127.0.0.1')).toBe(true);
    expect(isBlockedOutboundHostname('169.254.169.254')).toBe(true);
    expect(isBlockedOutboundHostname('10.1.2.3')).toBe(true);
    expect(isBlockedOutboundHostname('proxy.example.com')).toBe(false);
  });

  it('代理地址字面量为内网时直接拒绝', async () => {
    await expect(assertSafeProxyUrl('http://127.0.0.1:8888')).rejects.toThrow();
    await expect(assertSafeProxyUrl('http://169.254.169.254:80')).rejects.toThrow();
    await expect(getOutboundProxyDispatcher('http://localhost:8080')).rejects.toThrow();
  });

  it('代理地址解析到内网 IP 时拒绝（DNS 逐地址拦截）', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4, ttl: 60 }]);
    await expect(assertSafeProxyUrl('http://proxy.example.com:8080')).rejects.toThrow(/受限网络/);
    await expect(assertSafeOutboundUrl('http://example.com')).rejects.toThrow(/受限网络/);
  });

  it('代理允许携带认证信息，但普通出站地址不允许', async () => {
    await expect(
      assertSafeProxyUrl('http://user:pass@proxy.example.com:8080'),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl('http://user:pass@example.com'),
    ).rejects.toThrow(/受限主机/);
  });
});
