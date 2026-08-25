import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settingFindFirst: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: { setting: { findFirst: mocks.settingFindFirst } },
}));

import { GET, HEAD } from '@/app/api/health/route';

describe('health route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingFindFirst.mockResolvedValue({ id: 'health-check' });
  });

  it('数据库可用时公开返回无缓存的就绪状态', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.settingFindFirst).toHaveBeenCalledWith({ select: { id: true } });
    expect(HEAD).toBe(GET);
  });

  it('数据库不可用时返回 503，触发部署回滚', async () => {
    const error = new Error('database unavailable');
    mocks.settingFindFirst.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({ ok: false });
      expect(consoleError).toHaveBeenCalledWith('[health] database readiness check failed:', error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
