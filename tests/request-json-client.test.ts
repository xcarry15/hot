import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getApiToken: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  getApiToken: mocks.getApiToken,
}));

import { requestJson } from '@/lib/request-json.client';

describe('requestJson authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    global.fetch = mocks.fetch as unknown as typeof fetch;
  });

  it('显式注入本地 token，且不篡改调用方已有 Authorization', async () => {
    mocks.getApiToken.mockReturnValue('local-token');
    await requestJson('GET', '/api/articles');
    const firstHeaders = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(firstHeaders.get('Authorization')).toBe('Bearer local-token');

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
