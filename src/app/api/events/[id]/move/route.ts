import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { moveArticleToEvent } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await context.params;
    const body = await request.json().catch(() => ({}));
    const articleId = typeof body.articleId === 'string' ? body.articleId : '';
    const targetEventId = typeof body.targetEventId === 'string' ? body.targetEventId : '';
    const moved = await runExclusiveMutation('移动文章事件', () => moveArticleToEvent(articleId, targetEventId));
    return moved ? NextResponse.json({ ok: true }) : NextResponse.json({ error: '文章或目标事件无效' }, { status: 400 });
  } catch (error) {
    return apiError(error, '移动文章失败');
  }
}
