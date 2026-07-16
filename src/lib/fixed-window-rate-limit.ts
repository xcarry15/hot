import { NextResponse } from 'next/server';

type RateLimitEntry = { count: number; resetAt: number };

type FixedWindowRateLimitOptions = {
  windowMs: number;
  maxRequests: number;
  maxEntries: number;
  errorMessage: string;
};

/**
 * Nginx 模板会覆盖 X-Real-IP，并把真实来源追加在 X-Forwarded-For 末尾。
 * 优先使用 X-Real-IP；回退时取最右侧，避免客户端伪造首项绕过限流。
 */
export function getTrustedClientKey(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded?.at(-1) || 'anonymous';
}

export function createFixedWindowRateLimiter(options: FixedWindowRateLimitOptions) {
  const entries = new Map<string, RateLimitEntry>();

  function limited(resetAt: number, now: number): NextResponse {
    const response = NextResponse.json({ error: options.errorMessage }, { status: 429 });
    response.headers.set('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
    return response;
  }

  return (request: Request): NextResponse | null => {
    const now = Date.now();
    const key = getTrustedClientKey(request);
    let current = entries.get(key);

    if (!current || current.resetAt <= now) {
      if (!current && entries.size >= options.maxEntries) {
        for (const [entryKey, entry] of entries) {
          if (entry.resetAt <= now) entries.delete(entryKey);
        }
        if (entries.size >= options.maxEntries) return limited(now + options.windowMs, now);
      }
      current = { count: 1, resetAt: now + options.windowMs };
      entries.set(key, current);
      return null;
    }

    current.count += 1;
    return current.count <= options.maxRequests ? null : limited(current.resetAt, now);
  };
}
