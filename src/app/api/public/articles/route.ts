import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getPublicArticleFeedRevision, listPublicArticles } from '@/lib/public-article-service';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';

/**
 * Anonymous, read-only public article feed.
 * Keep this endpoint separate from /api/articles: the latter is an admin API.
 */
export async function GET(request: Request) {
  try {
    const limited = enforcePublicRateLimit(request);
    if (limited) return limited;
    const { searchParams } = new URL(request.url);
    const filters = {
      search: searchParams.get('q') ?? undefined,
      sourceId: searchParams.get('source') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    };
    if (searchParams.get('probe') === '1') {
      const response = NextResponse.json(await getPublicArticleFeedRevision(filters));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }

    const dateLimitRaw = searchParams.get('dateLimit');
    const dateLimitValue = dateLimitRaw === null ? undefined : Number(dateLimitRaw);
    const response = NextResponse.json(await listPublicArticles({
      ...filters,
      before: searchParams.get('before') ?? undefined,
      dateLimit: Number.isFinite(dateLimitValue) ? dateLimitValue : undefined,
    }));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch public articles');
  }
}
