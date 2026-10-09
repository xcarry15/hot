class RequestBodyError extends Error {
  readonly status = 400;
  readonly exposeToClient = true;
}

/** 同时检查声明长度与实际流长度，不能依赖可缺失或伪造的 Content-Length。 */
export async function readLimitedJson(request: Request, maxBytes: number, tooLargeMessage: string): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyError(tooLargeMessage);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError('请求正文不是有效 JSON');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new RequestBodyError('请求正文不是有效 JSON');
  }
}
