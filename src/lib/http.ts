/**
 * Shared HTTP utilities for parsers that need raw fetch.
 *
 * Used by raw server-side HTTP callers, including parser-canyin88.ts and the
 * proxy tester. Other parsers use the ZAI SDK directly.
 *
 * Provides:
 * - BROWSER_HEADERS: realistic browser-like request headers
 * - fetchWithRetry: exponential-backoff retry on network/timeout/5xx/429
 * - fetchHtml: fetch and decode HTML with charset detection (GBK/GB2312/UTF-8)
 * - fetchHtmlDetailed: same fetch with HTTP status, final URL and transport diagnostics
 * - hostFromUrl: extract protocol+host from a URL (for relative→absolute)
 * - optional global or per-request HTTP/HTTPS proxy dispatching
 *
 * Node's fetch transparently decompresses gzip/br/deflate when the
 * server sends `Content-Encoding`, so Accept-Encoding is mostly a hint
 * to upstream CDN/proxy to compress.
 */

import iconv from 'iconv-lite';
import { abortableDelay, withTimeout } from './shared/async';
import {
  assertSafeOutboundUrl,
  getOutboundProxyDispatcher,
  getSafeOutboundDispatcher,
} from './outbound-url';
import { getGlobalProxyUrl } from './proxy-config';

type SafeRequestInit = RequestInit & {
  /** 覆盖全局代理的单次 HTTP 代理，不进入请求头；通常只用于连通性测试。 */
  proxyUrl?: string;
  /** 列表源等公开资源需要直连时使用，避免被正在测试的失效代理阻塞。 */
  bypassProxy?: boolean;
  /** 覆盖共享 HTTP 层的默认重试次数；详情抓取由外层负责退避时可设为 0。 */
  retries?: number;
};

const CHARSET_RE = /charset\s*=\s*([^"'\s;>]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?([^"'\s;>]+)/i;

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
} as const;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2; // total 3 attempts
export const MAX_HTTP_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type FetchTransport = 'direct' | 'proxy';

export interface FetchHtmlResult {
  html: string | null;
  /** 最后一跳真实 HTTP 状态；网络错误时为 null。 */
  status: number | null;
  statusText: string;
  /** 重定向后的最终 URL；无法建立响应时回退到请求 URL。 */
  finalUrl: string;
  /** 本次请求实际使用的出站路径。 */
  transport: FetchTransport;
  /** 非 2xx、超时、网络或响应体解析失败的可读原因。 */
  error?: string;
}

export interface FetchDiagnostic {
  method: 'http' | 'zai';
  transport?: FetchTransport;
  status?: number | null;
  finalUrl?: string;
  error: string;
}

/** 诊断信息允许进入日志/Article.fetchError，但不能把 URL 中的凭据带出去。 */
export function safeUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    if (url.search) url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function formatFetchDiagnostics(diagnostics: FetchDiagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const route = diagnostic.method === 'http' && diagnostic.transport
      ? `${diagnostic.method}/${diagnostic.transport}`
      : diagnostic.method;
    const status = diagnostic.status === undefined || diagnostic.status === null
      ? ''
      : ` status=${diagnostic.status}`;
    const finalUrl = diagnostic.finalUrl ? ` finalUrl=${safeUrlForLog(diagnostic.finalUrl)}` : '';
    const error = diagnostic.error.replace(/\s+/g, ' ').slice(0, 500);
    return `${route}${status}${finalUrl}: ${error}`;
  }).join(' | ');
}

type RequestCookieJar = Map<string, Map<string, string>>;
const responseFinalUrls = new WeakMap<Response, string>();

function getResponseCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie?.call(headers) || [];
  if (cookies.length > 0) return cookies;

  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function rememberRedirectCookies(target: URL, response: Response, cookieJar: RequestCookieJar): void {
  const setCookies = getResponseCookies(response.headers);
  if (setCookies.length === 0) return;

  const hostname = target.hostname.toLowerCase();
  const hostCookies = cookieJar.get(hostname) || new Map<string, string>();
  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0]?.trim();
    const separator = pair?.indexOf('=') ?? -1;
    if (separator <= 0) continue;
    hostCookies.set(pair!.slice(0, separator).trim(), pair!.slice(separator + 1).trim());
  }
  if (hostCookies.size > 0) cookieJar.set(hostname, hostCookies);
}

function rememberClientCookie(target: URL, rawCookie: string, cookieJar: RequestCookieJar): boolean {
  const pair = rawCookie.split(';', 1)[0]?.trim();
  const separator = pair?.indexOf('=') ?? -1;
  if (separator <= 0) return false;

  const hostname = target.hostname.toLowerCase();
  const hostCookies = cookieJar.get(hostname) || new Map<string, string>();
  hostCookies.set(pair!.slice(0, separator).trim(), pair!.slice(separator + 1).trim());
  cookieJar.set(hostname, hostCookies);
  return true;
}

function requestHeadersWithCookies(target: URL, headers: HeadersInit | undefined, cookieJar: RequestCookieJar): Headers {
  const requestHeaders = new Headers(headers);
  if (requestHeaders.has('cookie')) return requestHeaders;

  const hostCookies = cookieJar.get(target.hostname.toLowerCase());
  if (hostCookies?.size) {
    requestHeaders.set('cookie', [...hostCookies].map(([name, value]) => `${name}=${value}`).join('; '));
  }
  return requestHeaders;
}

/**
 * 认证头只允许留在原始请求及同源重定向链中。
 * 即使出站 URL 已通过 SSRF 校验，也不能把调用方的密钥交给另一个合法公网主机。
 */
function stripSensitiveRedirectHeaders(headers: HeadersInit | undefined): Headers {
  // 跨源重定向只保留标准、非凭据请求头。使用 allowlist，避免遗漏新的
  // 自定义认证头（例如 api-key、x-access-token）导致凭据泄露。
  const safeHeaderNames = new Set([
    'accept',
    'accept-language',
    'cache-control',
    'pragma',
    'user-agent',
  ]);
  const safeHeaders = new Headers();
  for (const [name, value] of new Headers(headers)) {
    if (safeHeaderNames.has(name)) safeHeaders.set(name, value);
  }
  return safeHeaders;
}

/** HTTP 200 也可能是要求浏览器写 Cookie 后刷新的验证壳，不能视为有效页面。 */
function isLikelyJavaScriptVerificationPage(html: string): boolean {
  return html.length <= 4 * 1024
    && /\.cookie\s*=|document\.cookie/i.test(html)
    && /window\.open\s*\(/i.test(html);
}

function extractJavaScriptVerificationCookie(html: string): string | null {
  const match = html.match(/\.cookie\s*=\s*["']([^;"']+=[^;"']+)/i);
  return match?.[1]?.trim() || null;
}

export async function fetchSafe(
  rawUrl: string,
  options: SafeRequestInit = {},
): Promise<Response> {
  return fetchSafeWithCookieJar(rawUrl, options, new Map());
}

async function fetchSafeWithCookieJar(
  rawUrl: string,
  options: SafeRequestInit,
  cookieJar: RequestCookieJar,
): Promise<Response> {
  let target = await assertSafeOutboundUrl(rawUrl);
  let requestHeaders: HeadersInit | undefined = options.headers;
  const { proxyUrl, bypassProxy, ...requestOptions } = options;
  const effectiveProxyUrl = bypassProxy ? undefined : proxyUrl?.trim() || await getGlobalProxyUrl();
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(target, {
      ...requestOptions,
      headers: requestHeadersWithCookies(target, requestHeaders, cookieJar),
      redirect: 'manual',
      dispatcher: effectiveProxyUrl
        ? getOutboundProxyDispatcher(effectiveProxyUrl)
        : getSafeOutboundDispatcher(),
    } as RequestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      responseFinalUrls.set(response, target.toString());
      return response;
    }
    // 部分站点会在同域 302 中下发一次性验证 Cookie。Node fetch 不自带
    // Cookie jar，这里只在当前请求的同域重定向链里暂存，避免长期保存或跨域泄露。
    rememberRedirectCookies(target, response, cookieJar);
    const location = response.headers.get('location');
    if (!location) throw new Error(`重定向缺少 Location: ${target}`);
    await response.body?.cancel();
    const nextTarget = await assertSafeOutboundUrl(new URL(location, target).toString());
    if (nextTarget.origin !== target.origin) {
      requestHeaders = stripSensitiveRedirectHeaders(requestHeaders);
    }
    target = nextTarget;
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS}`);
}

function finalResponseUrl(response: Response, fallback: string): string {
  return responseFinalUrls.get(response) || response.url || fallback;
}

async function readResponseBuffer(response: Response, maxBytes = MAX_HTTP_RESPONSE_BYTES): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`响应体超过 ${maxBytes} 字节限制`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`响应体超过 ${maxBytes} 字节限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

export async function readResponseText(response: Response, maxBytes = MAX_HTTP_RESPONSE_BYTES): Promise<string> {
  return (await readResponseBuffer(response, maxBytes)).toString('utf-8');
}

export function ensureResponseTextWithinLimit(value: string, maxBytes = MAX_HTTP_RESPONSE_BYTES): string {
  if (Buffer.byteLength(value, 'utf-8') > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节限制`);
  return value;
}

/**
 * fetch with exponential-backoff retry.
 * - Network errors (DNS, connection refused, reset) → retry
 * - Timeout (AbortError) → retry
 * - 5xx / 429 / 408 / 425 → retry
 * - Other 4xx → return immediately (client error, no point retrying)
 */
async function fetchWithRetry(
  url: string,
  options: SafeRequestInit & { timeoutMs?: number } = {},
  retries: number = MAX_RETRIES,
  cookieJar?: RequestCookieJar,
): Promise<Response> {
  const {
    timeoutMs = 15_000,
    signal: parentSignal,
    retries: optionRetries,
    ...rest
  } = options;
  const retryLimit = optionRetries ?? retries;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    try {
      const response = await withTimeout(
        signal => cookieJar
          ? fetchSafeWithCookieJar(url, { ...rest, signal }, cookieJar)
          : fetchSafe(url, { ...rest, signal }),
        timeoutMs,
        `HTTP timeout: ${url}`,
        parentSignal ?? undefined,
      );

      if (RETRYABLE_STATUS.has(response.status) && attempt < retryLimit) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.warn(
          `[http] ${url} -> HTTP ${response.status}, retry ${attempt + 1}/${retryLimit} in ${delay}ms`,
        );
        await response.body?.cancel();
        await abortableDelay(delay, parentSignal ?? undefined);
        continue;
      }

      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (parentSignal?.aborted) throw err;
      const isAbort = /timeout|aborted|aborterror/i.test(errMsg);
      const isNetwork = /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|ETIMEDOUT/i.test(errMsg);

      lastError = new Error(isAbort ? `timeout after ${timeoutMs}ms` : errMsg);

      if ((isAbort || isNetwork) && attempt < retryLimit) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(
          `[http] ${url} -> ${lastError.message}, retry ${attempt + 1}/${retryLimit} in ${delay}ms`,
        );
        await abortableDelay(delay, parentSignal ?? undefined);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(`fetch ${url} failed after ${retryLimit + 1} attempts`);
}

/**
 * Extract protocol+host from a URL for use as a base for relative links.
 * Falls back to the URL string on parse failure.
 */
function hostFromUrl(url: string, fallback = 'https://www.canyin88.com'): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return fallback;
  }
}

/**
 * Detect charset from Content-Type header or <meta charset> tag.
 */
function detectCharset(response: Response, bodyStart: string): string {
  const contentType = response.headers.get('content-type') || '';
  const m = contentType.match(CHARSET_RE);
  if (m) return m[1].toLowerCase();
  const meta = bodyStart.match(META_CHARSET_RE);
  if (meta) return meta[1].toLowerCase();
  return 'utf-8';
}

async function readHtmlResponse(response: Response): Promise<string> {
  const buffer = await readResponseBuffer(response);
  const bodyStart = buffer.slice(0, 4096).toString('ascii').toLowerCase();
  const charset = detectCharset(response, bodyStart);
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    return iconv.decode(buffer, charset);
  }
  return buffer.toString('utf-8');
}

/**
 * Fetch a URL and decode the response body with correct charset.
 * Handles GBK/GB2312 (via iconv-lite) and UTF-8.
 */
export async function fetchHtmlDetailed(
  url: string,
  options: SafeRequestInit & { timeoutMs?: number } = {},
): Promise<FetchHtmlResult> {
  const {
    timeoutMs = 20_000,
    signal: parentSignal,
    proxyUrl,
    bypassProxy,
    retries,
    ...rest
  } = options;
  const explicitProxyUrl = proxyUrl?.trim();
  let effectiveProxyUrl: string | undefined;
  let transport: FetchTransport = bypassProxy || !explicitProxyUrl ? 'direct' : 'proxy';
  const baseRequestOptions = {
    ...rest,
    signal: parentSignal ?? undefined,
    timeoutMs,
    ...(retries === undefined ? {} : { retries }),
  };

  let responseForDiagnostics: Response | null = null;
  try {
    effectiveProxyUrl = bypassProxy ? undefined : explicitProxyUrl || await getGlobalProxyUrl();
    transport = effectiveProxyUrl ? 'proxy' : 'direct';
    const requestOptions = {
      ...baseRequestOptions,
      ...(effectiveProxyUrl ? { proxyUrl: effectiveProxyUrl } : { bypassProxy: true }),
    };
    const cookieJar: RequestCookieJar = new Map();
    let response = await fetchWithRetry(url, {
      ...requestOptions,
    }, MAX_RETRIES, cookieJar);
    responseForDiagnostics = response;
    const finalUrl = finalResponseUrl(response, url);
    if (!response.ok) {
      await response.body?.cancel();
      return {
        html: null,
        status: response.status,
        statusText: response.statusText || '',
        finalUrl,
        transport,
        error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      };
    }
    let html = await readHtmlResponse(response);

    // 只解析明确的 Cookie 赋值，不执行第三方脚本；Cookie 仍仅保留在本次请求的同域 jar。
    const verificationCookie = isLikelyJavaScriptVerificationPage(html)
      ? extractJavaScriptVerificationCookie(html)
      : null;
    if (verificationCookie && rememberClientCookie(new URL(url), verificationCookie, cookieJar)) {
      response = await fetchWithRetry(url, {
        ...requestOptions,
      }, MAX_RETRIES, cookieJar);
      responseForDiagnostics = response;
      if (!response.ok) {
        await response.body?.cancel();
        return {
          html: null,
          status: response.status,
          statusText: response.statusText || '',
          finalUrl: finalResponseUrl(response, url),
          transport,
          error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        };
      }
      html = await readHtmlResponse(response);
    }

    return {
      html,
      status: response.status,
      statusText: response.statusText || '',
      finalUrl: finalResponseUrl(response, url),
      transport,
    };
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    return {
      html: null,
      status: responseForDiagnostics?.status ?? null,
      statusText: responseForDiagnostics?.statusText || '',
      finalUrl: responseForDiagnostics ? finalResponseUrl(responseForDiagnostics, url) : url,
      transport,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchHtml(
  url: string,
  options: SafeRequestInit & { timeoutMs?: number } = {},
): Promise<string | null> {
  return (await fetchHtmlDetailed(url, options)).html;
}

export {
  BROWSER_HEADERS,
  fetchWithRetry,
  fetchHtml,
  hostFromUrl,
  isLikelyJavaScriptVerificationPage,
  MAX_RETRIES,
  RETRYABLE_STATUS,
};
