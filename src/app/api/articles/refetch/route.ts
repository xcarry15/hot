import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { refetchArticle } from '@/lib/article-refetch-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// POST /api/articles/refetch - Re-fetch article detail content
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { articleId } = body;

    if (!articleId) {
      return NextResponse.json({ error: 'Article ID is required' }, { status: 400 });
    }

    return NextResponse.json(await runExclusiveMutation('单篇重新抓取', () => refetchArticle(articleId)));
  } catch (error: unknown) {
    return apiError(error, 'Refetch failed');
  }
}
