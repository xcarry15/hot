import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { pushEventToFeishu } from '@/lib/push/delivery';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'repush' ? 'repush' : body.mode === 'manual' ? 'manual' : null;
    if (!mode) return NextResponse.json({ error: '推送模式无效' }, { status: 400 });
    const result = await runExclusiveMutation(
      mode === 'repush' ? '完整重新推送事件' : '人工强制推送事件',
      () => pushEventToFeishu(id, mode === 'repush' ? 'repush_all' : 'manual_force'),
    );
    return NextResponse.json(result, { status: result.status === 'failed' ? 409 : 200 });
  } catch (error) {
    return apiError(error, '事件推送失败');
  }
}
