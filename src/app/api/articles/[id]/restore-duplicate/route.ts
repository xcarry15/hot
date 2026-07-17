import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runJob } from '@/lib/execution';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await runJob('ai', { articleId: id, trigger: 'manual', reason: 'restore-duplicate', restoreDuplicate: true });
    if (!result.queued) {
      return NextResponse.json({ restored: true, queued: false, reason: result.reason }, { status: 409 });
    }
    return NextResponse.json({ restored: true, queued: true, jobId: result.jobId });
  } catch (error: unknown) {
    return apiError(error, '恢复重复文章失败');
  }
}
