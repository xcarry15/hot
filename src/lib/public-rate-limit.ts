import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const entries = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: Request): string {
  // x-forwarded-for is only trusted when the app is deployed behind the
  // configured reverse proxy. The fallback still protects one process from
  // accidental request floods.
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'anonymous';
}

export function enforcePublicRateLimit(request: Request): NextResponse | null {
  const now = Date.now();
  if (entries.size > 5000) {
    for (const [entryKey, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(entryKey);
    }
  }
  const key = getClientKey(request);
  const current = entries.get(key);
  if (!current || current.resetAt <= now) {
    entries.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  current.count += 1;
  if (current.count <= MAX_REQUESTS_PER_WINDOW) return null;

  const response = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  response.headers.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
  return response;
}
