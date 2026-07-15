import { NextResponse } from 'next/server';

const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'anonymous';
}

export function enforceAdminAuthRateLimit(request: Request): NextResponse | null {
  const now = Date.now();
  const key = getClientKey(request);
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  current.count += 1;
  if (current.count <= MAX_ATTEMPTS) return null;

  const response = NextResponse.json({ error: '登录尝试过于频繁，请稍后再试' }, { status: 429 });
  response.headers.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
  return response;
}
