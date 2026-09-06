import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
  readResponseText: vi.fn(),
  withTimeout: vi.fn(),
}));

vi.mock('@/lib/http', () => ({
  fetchSafe: mocks.fetchSafe,
  readResponseText: mocks.readResponseText,
}));
vi.mock('@/lib/shared/async', () => ({
  withTimeout: mocks.withTimeout,
}));

import { fetchModelCatalog } from '@/lib/model-discovery';

describe('fetchModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTimeout.mockImplementation((operation: (signal: AbortSignal) => Promise<unknown>) => (
      operation(new AbortController().signal)
    ));
  });

  it('统一传递 JSON 请求并解析成功目录', async () => {
    const response = new Response('{}', { status: 200 });
    mocks.fetchSafe.mockResolvedValue(response);
    mocks.readResponseText.mockResolvedValue('{"data":[]}');

    await expect(fetchModelCatalog('https://example.com/models', '目录超时')).resolves.toEqual({
      ok: true,
      status: 200,
      payload: { data: [] },
    });
    expect(mocks.fetchSafe).toHaveBeenCalledWith('https://example.com/models', expect.objectContaining({
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }));
  });

  it('保留非 2xx 状态，由 Provider Route 决定对外文案', async () => {
    mocks.fetchSafe.mockResolvedValue(new Response('', { status: 503 }));

    await expect(fetchModelCatalog('https://example.com/models', '目录超时')).resolves.toEqual({
      ok: false,
      status: 503,
    });
    expect(mocks.readResponseText).not.toHaveBeenCalled();
  });
});
