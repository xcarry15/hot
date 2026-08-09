import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

import { requestJson } from '@/lib/request-json.client';

describe('requestJson request boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    global.fetch = mocks.fetch as unknown as typeof fetch;
  });

  it('不读取浏览器 Token，且保留调用方显式 Authorization', async () => {
    await requestJson('GET', '/api/articles');
    const firstHeaders = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(firstHeaders.get('Authorization')).toBeNull();

    await requestJson('GET', '/api/articles', {
      headers: { Authorization: 'Bearer explicit-token' },
    });
    const secondHeaders = new Headers(mocks.fetch.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get('Authorization')).toBe('Bearer explicit-token');
  });

  it('DELETE 携带 JSON body，供资源删除接口接收明确 id', async () => {
    await requestJson('DELETE', '/api/settings/prompt-versions', { body: { id: 'version-1' } });

    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBe(JSON.stringify({ id: 'version-1' }));
    expect(new Headers(request.headers).get('Content-Type')).toBe('application/json');
  });
});
