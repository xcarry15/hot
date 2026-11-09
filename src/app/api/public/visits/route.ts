import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createFixedWindowRateLimiter } from '@/lib/fixed-window-rate-limit';
import { getTrustedClientKey } from '@/lib/fixed-window-rate-limit';
import { recordVisit } from '@/lib/visit-analytics-service';

const enforceVisitRateLimit = createFixedWindowRateLimiter({ windowMs: 60_000, maxRequests: 120, maxEntries: 5000, errorMessage: 'Too many requests' });
const schema = z.object({ visitorId: z.uuid(), kind: z.enum(['page', 'tool']), toolId: z.string().max(100).optional(), referrer: z.string().max(512).default('') }).strict().refine((v) => v.kind !== 'tool' || Boolean(v.toolId));
export async function POST(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || request.headers.get('sec-fetch-site') === 'cross-site') return new NextResponse(null, { status: 403 });
  const limited = enforceVisitRateLimit(request);
  if (limited) return limited;
  if (Number(request.headers.get('content-length') || 0) > 2048) return new NextResponse(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new NextResponse(null, { status: 400 });
  let text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > 2048) { await reader.cancel(); return new NextResponse(null, { status: 413 }); }
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return new NextResponse(null, { status: 400 }); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  try { await recordVisit({ ...parsed.data, host: new URL(request.url).host, clientIp: getTrustedClientKey(request) }); } catch { return new NextResponse(null, { status: 503 }); }
  return new NextResponse(null, { status: 204 });
}
