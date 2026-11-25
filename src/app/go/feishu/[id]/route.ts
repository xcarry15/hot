import { enforcePublicRateLimit } from '@/lib/public-rate-limit';
import { verifyFeishuOriginalLink } from '@/lib/push/feishu-original-link';
import { resolveFeishuOriginal } from '@/lib/push/feishu-original-service';

const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signature = new URL(request.url).searchParams.get('sig');
  if (!verifyFeishuOriginalLink(id, signature)) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  const isPrefetch = ['purpose', 'sec-purpose'].some((name) =>
    /\b(prefetch|preview|prerender)\b/i.test(request.headers.get(name) ?? ''),
  );
  const countClick = !isPrefetch && !enforcePublicRateLimit(request);
  const originalUrl = await resolveFeishuOriginal(id, countClick);
  if (!originalUrl) return new Response(null, { status: 404, headers: responseHeaders });
  return new Response(null, {
    status: 302,
    headers: { ...responseHeaders, Location: originalUrl },
  });
}

export function HEAD() {
  return new Response(null, { status: 204, headers: responseHeaders });
}
