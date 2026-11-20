class RequestBodyError extends Error {
  readonly status: number = 400;
  readonly exposeToClient = true;
}

/** 超限：仅在启用读取超时的调用点使用，返回 413 而不是笼统的 400。 */
export class RequestBodyTooLargeError extends RequestBodyError {
  override readonly status = 413;
}

/** 读取流阶段的墙钟超时（慢速体占住连接），返回 408。 */
export class RequestBodyTimeoutError extends Error {
  readonly status = 408;
  readonly exposeToClient = true;
}

export const MAX_SMALL_JSON_BODY_BYTES = 16 * 1024;

interface ReadOptions {
  /** 仅作用于读取流的墙钟时间；不设则完全没有超时，兼容备份等长请求。 */
  timeoutMs?: number;
}

/**
 * 同时检查声明长度与实际流长度，不能依赖可缺失或伪造的 Content-Length。
 * 传入 timeoutMs 时，读取阶段有墙钟超时，并把超时/超限区分为 408/413。
 */
export async function readLimitedBytes(
  request: Request,
  maxBytes: number,
  tooLargeMessage: string,
  options: ReadOptions = {},
): Promise<Buffer> {
  const tooLargeError = (): RequestBodyError => options.timeoutMs === undefined
    ? new RequestBodyError(tooLargeMessage)
    : new RequestBodyTooLargeError(tooLargeMessage);

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: Promise<never> | undefined;
  let timedOut = false;
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // cancel() 会把未完成的 read 变成 done:true，必须先置位并拒绝 deadline，
        // 避免超时被 race 误判为正常结束。
        timedOut = true;
        reject(new RequestBodyTimeoutError('请求正文读取超时'));
        void reader.cancel().catch(() => undefined);
      }, timeoutMs);
    });
  }

  try {
    while (true) {
      const result = deadline
        ? await Promise.race([reader.read(), deadline])
        : await reader.read();
      if (timedOut) throw new RequestBodyTimeoutError('请求正文读取超时');
      const { done, value } = result;
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
    // 超时后 reader 可能仍有未完成的 read，releaseLock 会抛错；忽略即可。
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  return Buffer.concat(chunks, length);
}

export async function readLimitedJson(
  request: Request,
  maxBytes: number,
  tooLargeMessage: string,
  options: ReadOptions = {},
): Promise<unknown> {
  const body = await readLimitedBytes(request, maxBytes, tooLargeMessage, options);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RequestBodyError('请求正文不是有效 JSON');
  }
}
