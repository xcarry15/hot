import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { mergeEvents } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sourceEventId = typeof body.sourceEventId === 'string' ? body.sourceEventId : '';
    const targetEventId = typeof body.targetEventId === 'string' ? body.targetEventId : '';
    const merged = await runExclusiveMutation('合并事件', () => mergeEvents(sourceEventId, targetEventId));
    return merged ? NextResponse.json({ ok: true }) : NextResponse.json({ error: '事件不存在、状态无效或参数错误' }, { status: 400 });
  } catch (error) {
    return apiError(error, '合并事件失败');
  }
}
