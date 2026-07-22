import { describe, expect, it } from 'vitest';
import { GET, HEAD } from '@/app/api/health/route';

describe('health route', () => {
  it('公开返回无缓存的轻量存活状态', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(HEAD).toBe(GET);
  });
});
