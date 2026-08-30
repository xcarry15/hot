import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settingFindFirst: vi.fn(), readFile: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: { setting: { findFirst: mocks.settingFindFirst } },
}));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));

import { GET, HEAD } from '@/app/api/health/route';

describe('health route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingFindFirst.mockResolvedValue({ id: 'health-check' });
    mocks.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  });

  it('数据库可用时公开返回无缓存的就绪状态', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true, revision: null });
    expect(mocks.settingFindFirst).toHaveBeenCalledWith({ select: { id: true } });
    expect(HEAD).toBe(GET);
  });

  it('发布包包含 revision 标记时随健康状态返回', async () => {
    const revision = '0123456789abcdef0123456789abcdef01234567';
    mocks.readFile.mockResolvedValue(`${revision}\n`);

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ ok: true, revision });
    expect(mocks.readFile).toHaveBeenCalledWith(expect.stringContaining('.release-revision'), 'utf8');
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
