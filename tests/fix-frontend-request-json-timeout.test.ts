import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRequestAborted,
  isRequestJsonError,
  requestJson,
} from '@/lib/request-json.client';

/** 永不自行 resolve 的 fetch：只在 signal 取消时以原生 AbortError 结束。 */
function pendingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    );
  });
}

/** 把 catch 到的 unknown 收窄为 Error，便于断言 message。 */
function asError(value: unknown): Error {
  expect(value).toBeInstanceOf(Error);
  if (!(value instanceof Error)) throw new Error('expected an Error');
  return value;
}

describe('requestJson 可配超时（默认关闭，不破坏调用方 signal）', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('未启用超时时调用方 signal 原样透传，行为不变', async () => {
    const controller = new AbortController();
    // 显式声明 mock 参数类型，避免 vi.fn 推断出零参数元组导致 mock.calls[0][1] 为 never。
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      void _url; void _init;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestJson('GET', '/api/x', { signal: controller.signal });

    expect(result).toBeUndefined();
    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('显式 timeoutMs 触发后抛 status=0 的请求超时错误，不被当作取消', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', pendingFetch());

    // 先挂 catch，避免 fake timer 推进期间产生未处理的 rejection。
    const settled = requestJson('GET', '/api/x', { timeoutMs: 50 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(50);
    const error = asError(await settled);

    expect(isRequestJsonError(error, 0)).toBe(true);
    expect(error.message).toBe('请求超时');
    expect(isRequestAborted(error)).toBe(false);
  });

  it('外部 signal 取消仍返回 499，且不被超时逻辑误判', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', pendingFetch());
    const controller = new AbortController();

    const settled = requestJson('GET', '/api/x', {
      signal: controller.signal,
      timeoutMs: 1000,
    }).catch((err: unknown) => err);
    controller.abort();
    const error = asError(await settled);

    expect(isRequestJsonError(error, 499)).toBe(true);
    expect(isRequestAborted(error)).toBe(true);
    expect(error.message).not.toBe('请求超时');
  });
});
