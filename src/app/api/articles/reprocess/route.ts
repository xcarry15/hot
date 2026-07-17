import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runJob } from '@/lib/execution';

// POST /api/articles/reprocess - Re-run AI on an article
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { articleId, articleIds } = body;

    if (Array.isArray(articleIds)) {
      const ids = [...new Set(articleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
      if (ids.length === 0) return NextResponse.json({ error: 'Article IDs are required' }, { status: 400 });
      if (ids.length > 100) return NextResponse.json({ error: '单次最多重新分析 100 篇文章' }, { status: 400 });
      const result = await runJob('ai', { articleIds: ids, trigger: 'manual', scope: 'selected' });
      if (!result.queued) return NextResponse.json({ success: false, queued: false, reason: result.reason }, { status: 409 });
      return NextResponse.json({ success: true, queued: true, jobId: result.jobId });
    }

    if (!articleId) {
      return NextResponse.json({ error: 'Article ID is required' }, { status: 400 });
    }

    const result = await runJob('ai', {
      articleId,
      trigger: 'manual',
      scope: 'single',
    });

    if (!result.queued) {
      return NextResponse.json(
        { success: false, queued: false, reason: result.reason },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true, queued: true, jobId: result.jobId });
  } catch (error: unknown) {
    return apiError(error, 'Reprocess failed');
  }
}
