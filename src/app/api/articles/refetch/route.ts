import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { refetchArticle } from '@/lib/article-refetch-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// POST /api/articles/refetch - Re-fetch article detail content
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { articleId, articleIds } = body;

    if (Array.isArray(articleIds)) {
      const ids = [...new Set(articleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
      if (ids.length === 0) return NextResponse.json({ error: 'Article IDs are required' }, { status: 400 });
      if (ids.length > 100) return NextResponse.json({ error: '单次最多重新抓取 100 篇文章' }, { status: 400 });
      const result = await runExclusiveMutation('批量重新抓取', async () => {
        let processed = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const item = await refetchArticle(id);
            if (item) processed++; else failed++;
          } catch {
            failed++;
          }
        }
        return { processed, failed };
      });
      return NextResponse.json(result);
    }

    if (!articleId) {
      return NextResponse.json({ error: 'Article ID is required' }, { status: 400 });
    }

    const result = await runExclusiveMutation('单篇重新抓取', () => refetchArticle(articleId));
    if (!result) return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error, 'Refetch failed');
  }
}
