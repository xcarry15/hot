import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getPublicArticleDetail } from '@/lib/public-article-service';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';

/** Anonymous, read-only public article detail. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const limited = enforcePublicRateLimit(_request);
    if (limited) return limited;
    const { id } = await params;
    const article = await getPublicArticleDetail(id);
    if (!article) return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    const response = NextResponse.json(article);
    // Detail eligibility is checked against the database on every request;
    // do not let a browser/CDN retain a now-private article.
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch public article');
  }
}
