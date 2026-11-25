import { requireAdminAuth } from '@/lib/require-admin-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { confirmIndependentBatch, CONFIRM_INDEPENDENT_BATCH_LIMIT } from '@/lib/event-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

export async function POST(request: Request) {
  const denied = request ? requireAdminAuth(request as NextRequest) : null;
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    const rawIds = Array.isArray(body.articleIds)
      ? body.articleIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    if (rawIds.length === 0) {
      return NextResponse.json({ error: '请先选择要确认的文章' }, { status: 400 });
    }
    const truncated = rawIds.length > CONFIRM_INDEPENDENT_BATCH_LIMIT;
    const result = await runExclusiveMutation('批量确认独立事件', () => confirmIndependentBatch(rawIds));
    return NextResponse.json({ ok: true, ...result, truncated });
  } catch (error) {
    return apiError(error, '批量确认独立事件失败');
  }
}
