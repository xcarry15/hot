/**
 * 客户端请求 helper：把通用 fetch + JSON + 错误 + AbortSignal 收敛到此。
 *
 * 设计原则（按 B15 计划）：
 *   - 只统一 fetch 的样板（JSON / 头部 / 错误解析 / AbortSignal 传递）
 *   - 不引入缓存、重试、全局状态或 optimistic update
 *   - 不做 endpoint 拼装，endpoint 拼装由各 feature api client 负责
 *
 * 使用：
 *   import { requestJson } from '@/lib/request-json.client';
 *   const data = await requestJson<MyDto>('GET', '/api/foo', undefined, signal);
 *   const data = await requestJson<MyDto>('POST', '/api/bar', { body: 'x' }, signal);
 */
import { getApiToken } from '@/lib/api-client';

export interface RequestJsonError extends Error {
  status: number;
  body?: unknown;
}

export interface RequestJsonInit<B = unknown> {
  body?: B;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function makeError(status: number, body: unknown, fallbackMessage: string): RequestJsonError {
  const err = new Error(
    typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
      ? ((body as { error: string }).error)
      : fallbackMessage,
  ) as RequestJsonError;
  err.name = 'RequestJsonError';
  err.status = status;
  err.body = body;
  return err;
}

export async function requestJson<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  init: RequestJsonInit = {},
): Promise<T> {
  const { body, signal, headers } = init;
  const hasBody = body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE';
  const finalHeaders = new Headers(headers);
  if (hasBody && !finalHeaders.has('Content-Type')) {
    finalHeaders.set('Content-Type', 'application/json');
  }
  if (!finalHeaders.has('Authorization')) {
    const token = getApiToken();
    if (token) finalHeaders.set('Authorization', `Bearer ${token}`);
  }
  const requestInit: RequestInit = {
    method,
    signal,
    headers: finalHeaders,
  };
  if (hasBody) {
    requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, requestInit);
  } catch (err) {
    // 浏览器切页、开发环境热更新或上层主动取消时，fetch 会抛原生
    // AbortError。不要把 DOMException 继续抛给 React/Next 运行时，否则
    // 会触发错误覆盖层；统一包装后由业务队列决定跳过或重试。
    if ((err instanceof DOMException && err.name === 'AbortError')
      || (err instanceof Error && err.name === 'AbortError')) {
      throw makeError(499, { error: '请求已取消' }, 'Request aborted');
    }
    throw makeError(0, undefined, err instanceof Error ? err.message : 'Network error');
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  } else {
    parsed = undefined;
  }

  if (!res.ok) {
    throw makeError(res.status, parsed, `HTTP ${res.status}`);
  }
  return parsed as T;
}
