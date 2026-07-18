import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getEventArticles, setEventRepresentative } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const event = await getEventArticles(id);
    return event ? NextResponse.json(event) : NextResponse.json({ error: '事件不存在' }, { status: 404 });
  } catch (error) {
    return apiError(error, '读取事件失败');
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const articleId = typeof body.representativeArticleId === 'string' ? body.representativeArticleId : '';
    const updated = await runExclusiveMutation('指定代表文章', () => setEventRepresentative(id, articleId));
    return updated ? NextResponse.json({ ok: true }) : NextResponse.json({ error: '文章不属于该事件' }, { status: 400 });
  } catch (error) {
    return apiError(error, '指定代表文章失败');
  }
}
