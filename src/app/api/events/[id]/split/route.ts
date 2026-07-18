import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { splitEventArticles } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const articleIds = Array.isArray(body.articleIds) ? body.articleIds.filter((value: unknown): value is string => typeof value === 'string').slice(0, 100) : [];
    const eventId = await runExclusiveMutation('拆分事件', () => splitEventArticles(id, articleIds));
    return eventId ? NextResponse.json({ ok: true, eventId }) : NextResponse.json({ error: '拆分文章无效，不能拆出全部来源' }, { status: 400 });
  } catch (error) {
    return apiError(error, '拆分事件失败');
  }
}
