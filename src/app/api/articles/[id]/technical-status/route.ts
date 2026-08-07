import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { updateTechnicalIgnoreState } from '@/lib/technical-work-queue-service';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const action = body.action === 'ignore' ? 'ignore' : body.action === 'restore' ? 'restore' : null;
    if (!action) return NextResponse.json({ error: 'action 无效' }, { status: 400 });
    if (!await updateTechnicalIgnoreState(id, action)) return NextResponse.json({ error: '文章不存在' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, '更新技术异常状态失败');
  }
}
