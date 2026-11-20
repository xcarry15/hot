import { describe, expect, it, vi } from 'vitest';
import { apiError } from '@/lib/api-helpers';
import {
  readLimitedBytes,
  readLimitedJson,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from '@/lib/request-body';

function stalledRequest(): Request {
  // pull 永不 settle：任何成功读取都必须等定时器触发超时。
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  return new Request('http://localhost', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit);
}

function quickRequest(text: string): Request {
  return new Request('http://localhost', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

describe('P1 安全专项：请求体读取墙钟超时与 408/413', () => {
  it('慢速体在读取阶段触发 408 超时', async () => {
    await expect(
      readLimitedJson(stalledRequest(), 100, 'too large', { timeoutMs: 25 }),
    ).rejects.toMatchObject({ status: 408, exposeToClient: true });
  });

  it('启用超时模式下超限返回 413', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('1234567890')); },
      cancel,
    });
    const request = new Request('http://localhost', {
      method: 'POST', body: stream, duplex: 'half',
    } as RequestInit);
    await expect(
      readLimitedBytes(request, 5, 'too large', { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ status: 413, message: 'too large' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('未启用超时时保持原有 400 语义（兼容既有调用方）', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('1234567890')); },
    });
    const request = new Request('http://localhost', {
      method: 'POST', body: stream, duplex: 'half',
    } as RequestInit);
    await expect(readLimitedBytes(request, 5, 'too large')).rejects.toMatchObject({ status: 400 });
  });

  it('超时模式下正常请求不受影响', async () => {
    await expect(
      readLimitedJson(quickRequest('{"a":1}'), 100, 'too large', { timeoutMs: 1_000 }),
    ).resolves.toEqual({ a: 1 });
  });

  it('超时/超限错误经 apiError 分别透传为 408/413', () => {
    const timeoutResponse = apiError(new RequestBodyTimeoutError('请求正文读取超时'), '读取失败', 500);
    expect(timeoutResponse.status).toBe(408);

    const tooLargeResponse = apiError(new RequestBodyTooLargeError('请求正文过大'), '读取失败', 500);
    expect(tooLargeResponse.status).toBe(413);
  });
});
