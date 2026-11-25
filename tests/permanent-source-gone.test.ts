import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { article: { updateMany: mocks.updateMany } },
}));
vi.mock('@/lib/execution-write-guard', () => ({
  assertWorkerCanWrite: vi.fn(async () => undefined),
}));

import { autoIgnoreIfSourceGone, isPermanentSourceGone } from '@/lib/detail-fetcher';
import type { FetchDiagnostic } from '@/lib/http';

const http = (status: number | null, method: 'http' | 'zai' = 'http'): FetchDiagnostic => ({
  method, status, error: `HTTP ${status}`,
});

describe('源站永久下线识别（404/410）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('404 / 410 判定为永久下线', () => {
    expect(isPermanentSourceGone([http(404)])).toBe(true);
    expect(isPermanentSourceGone([http(410)])).toBe(true);
    expect(isPermanentSourceGone([http(404), http(410)])).toBe(true);
  });

  it('zai 兜底诊断不带 status，不干扰判定', () => {
    expect(isPermanentSourceGone([http(404), http(null, 'zai')])).toBe(true);
  });

  it('混合可恢复状态（5xx/429/网络错误）不判定为永久下线', () => {
    expect(isPermanentSourceGone([http(404), http(500)])).toBe(false);
    expect(isPermanentSourceGone([http(404), http(429)])).toBe(false);
    expect(isPermanentSourceGone([http(404), http(null)])).toBe(false);
    expect(isPermanentSourceGone([])).toBe(false);
    expect(isPermanentSourceGone([http(500)])).toBe(false);
  });

  it('永久下线时写入 technicalIgnoredAt', async () => {
    await expect(autoIgnoreIfSourceGone('a1', [http(404), http(null, 'zai')])).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    const call = mocks.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1' });
    expect(call.data.technicalIgnoredAt).toBeInstanceOf(Date);
  });

  it('非永久下线时不写 technicalIgnoredAt', async () => {
    await expect(autoIgnoreIfSourceGone('a2', [http(404), http(500)])).resolves.toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
