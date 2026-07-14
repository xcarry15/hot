/**
 * Shared HTTP utilities for parsers that need raw fetch.
 *
 * Currently used by:
 * - parser-canyin88.ts (only parser doing direct fetch; others use ZAI SDK)
 *
 * Provides:
 * - BROWSER_HEADERS: realistic browser-like request headers
 * - fetchWithRetry: exponential-backoff retry on network/timeout/5xx/429
 * - fetchHtml: fetch and decode HTML with charset detection (GBK/GB2312/UTF-8)
 * - hostFromUrl: extract protocol+host from a URL (for relative→absolute)
 *
 * Node's fetch transparently decompresses gzip/br/deflate when the
 * server sends `Content-Encoding`, so Accept-Encoding is mostly a hint
 * to upstream CDN/proxy to compress.
 */

import iconv from 'iconv-lite';
import { abortableDelay, withTimeout } from './shared/async';

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

/**
 * fetch with exponential-backoff retry.
 * - Network errors (DNS, connection refused, reset) → retry
 * - Timeout (AbortError) → retry
 * - 5xx / 429 / 408 / 425 → retry
 * - Other 4xx → return immediately (client error, no point retrying)
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retries: number = MAX_RETRIES,
): Promise<Response> {
  const { timeoutMs = 15_000, signal: parentSignal, ...rest } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await withTimeout(
        signal => fetch(url, { ...rest, signal }),
        timeoutMs,
        `HTTP timeout: ${url}`,
        parentSignal ?? undefined,
      );

      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.warn(
          `[http] ${url} -> HTTP ${response.status}, retry ${attempt + 1}/${retries} in ${delay}ms`,
        );
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

      if ((isAbort || isNetwork) && attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(
          `[http] ${url} -> ${lastError.message}, retry ${attempt + 1}/${retries} in ${delay}ms`,
        );
        await abortableDelay(delay, parentSignal ?? undefined);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error(`fetch ${url} failed after ${retries + 1} attempts`);
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

/**
 * Fetch a URL and decode the response body with correct charset.
 * Handles GBK/GB2312 (via iconv-lite) and UTF-8.
 */
async function fetchHtml(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<string | null> {
  const { timeoutMs = 20_000, signal: parentSignal, ...rest } = options;

  try {
    const response = await withTimeout(
      signal => fetch(url, { ...rest, signal }),
      timeoutMs,
      `HTML fetch timeout: ${url}`,
      parentSignal ?? undefined,
    );

    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const bodyStart = buffer.slice(0, 4096).toString('ascii').toLowerCase();
    const charset = detectCharset(response, bodyStart);

    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return iconv.decode(buffer, charset);
    }
    return buffer.toString('utf-8');
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    return null;
  }
}

export { BROWSER_HEADERS, fetchWithRetry, fetchHtml, hostFromUrl, MAX_RETRIES, RETRYABLE_STATUS };
