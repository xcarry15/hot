import { describe, expect, it, vi } from 'vitest';
import { readLimitedJson } from '@/lib/request-body';

function streamedRequest(chunks: string[], contentLength?: string) {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
    cancel,
  });
  const request = new Request('http://localhost', {
    method: 'POST', body: stream, duplex: 'half',
    headers: contentLength === undefined ? {} : { 'Content-Length': contentLength },
  } as RequestInit);
  return { request, cancel };
}

describe('请求正文的实际字节限制', () => {
  it.each([undefined, '1'])('缺失或伪造长度 %s 时仍拒绝超限正文并取消读取', async (length) => {
    const { request, cancel } = streamedRequest(['{"text":"', 'abcdef', '"}'], length);
    await expect(readLimitedJson(request, 10, 'too large')).rejects.toMatchObject({ message: 'too large', status: 400 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('中文按 UTF-8 字节计数，而非字符数', async () => {
    const { request } = streamedRequest(['"中"']);
    await expect(readLimitedJson(request, 4, 'too large')).rejects.toThrow('too large');
  });

  it('边界大小的合法 JSON 可分块读取', async () => {
    const { request } = streamedRequest(['{"', 'a":', '1}']);
    await expect(readLimitedJson(request, 7, 'too large')).resolves.toEqual({ a: 1 });
  });

  it('无效 JSON 返回客户端错误', async () => {
    const { request } = streamedRequest(['invalid']);
    await expect(readLimitedJson(request, 10, 'too large')).rejects.toMatchObject({ status: 400 });
  });

  it('声明超限时不读取正文', async () => {
    const { request } = streamedRequest(['{}'], '100');
    await expect(readLimitedJson(request, 10, 'too large')).rejects.toThrow('too large');
    expect(request.bodyUsed).toBe(false);
  });
});
