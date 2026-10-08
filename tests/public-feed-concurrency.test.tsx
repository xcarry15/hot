// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicArticleFeed from '@/components/public-article-feed';
import type { PublicArticleListResponseDto } from '@/contracts/public-articles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const initial: PublicArticleListResponseDto = {
  total: 1, revision: 'v1', groups: [], displayedArticleCount: 0,
  displayedDateCount: 0, nextCursor: null, hasMore: false,
};

function response(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

function pendingResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('公开更新探测的旧响应', () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockReset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it.each(['before', 'during'])('刷新%s时发起的旧探测，晚返回不能重新点亮提示', async (timing) => {
    const oldProbe = pendingResponse();
    const refresh = pendingResponse();
    vi.mocked(fetch).mockImplementation((url) => {
      if (!String(url).includes('probe=1')) return refresh.promise;
      const probes = vi.mocked(fetch).mock.calls.filter(([value]) => String(value).includes('probe=1'));
      return probes.length === 1 ? Promise.resolve(response({ total: 1, revision: 'v2' })) : oldProbe.promise;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<PublicArticleFeed initialData={initial} search="" hasFilter={false} />));
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(container.textContent).toContain('资讯有更新');

    if (timing === 'before') await act(async () => { vi.advanceTimersByTime(60_000); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="button"]')?.click(); });
    if (timing === 'during') await act(async () => { vi.advanceTimersByTime(60_000); });
    await act(async () => { refresh.resolve(response({ ...initial, revision: 'v2' })); });
    expect(container.textContent).not.toContain('资讯有更新');
    await act(async () => { oldProbe.resolve(response({ total: 1, revision: 'v1' })); });
    expect(container.textContent).not.toContain('资讯有更新');
  });
});
