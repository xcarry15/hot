import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { listPublicArticles } from '@/lib/public-article-service';
import { parsePositiveInt } from '@/lib/pagination';
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
    const response = NextResponse.json(await listPublicArticles({
      page: parsePositiveInt(searchParams.get('page'), 1),
      pageSize: 20,
      search: searchParams.get('q') ?? undefined,
      sourceId: searchParams.get('source') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    }));
    response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    return response;
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch public articles');
  }
}
