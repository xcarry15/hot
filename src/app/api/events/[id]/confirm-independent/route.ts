import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { confirmIndependentArticle } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const articleId = typeof body.articleId === 'string' ? body.articleId : '';
    const updated = await runExclusiveMutation('确认独立事件', () => confirmIndependentArticle(id, articleId));
    return updated ? NextResponse.json({ ok: true }) : NextResponse.json({ error: '文章不是当前待复核事件成员' }, { status: 400 });
  } catch (error) {
    return apiError(error, '确认独立事件失败');
  }
}
