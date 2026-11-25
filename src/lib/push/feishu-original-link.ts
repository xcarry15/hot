import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPublicSiteUrl } from '@/lib/public-site';

function signArticleId(articleId: string): string | null {
  const secret = process.env.SESSION_SECRET?.trim() || process.env.API_TOKEN?.trim();
  return secret
    ? createHmac('sha256', secret).update(`feishu-original-v1:${articleId}`).digest('base64url')
    : null;
}

export function buildFeishuOriginalUrl(articleId: string, originalUrl: string): string {
  const signature = signArticleId(articleId);
  if (!signature) return originalUrl;
  const url = new URL(`/go/feishu/${encodeURIComponent(articleId)}`, getPublicSiteUrl());
  url.searchParams.set('sig', signature);
  return url.toString();
}

export function verifyFeishuOriginalLink(articleId: string, signature: string | null): boolean {
  if (!signature || !/^[a-zA-Z0-9_-]{43}$/.test(signature)) return false;
  const expected = signArticleId(articleId);
  return expected !== null && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
