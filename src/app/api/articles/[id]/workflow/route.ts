import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runJob, validateSingleArticleWorkflow, type JobType } from '@/lib/execution';

type StartAt = 'process' | 'cluster' | 'ai' | 'push';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const startAt = body.startAt as StartAt;
    const intent = body.intent === 'regenerate' ? 'regenerate' : body.intent === 'retry' ? 'retry' : null;
    if (!['process', 'cluster', 'ai', 'push'].includes(startAt) || !intent) {
      return NextResponse.json({ error: 'startAt 或 intent 无效' }, { status: 400 });
    }
    const validation = await validateSingleArticleWorkflow(id, startAt, intent);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: validation.status });
    }
    const result = await runJob(startAt as JobType, {
      scope: 'single',
      workflow: true,
      articleId: id,
      startAt,
      intent,
      trigger: 'manual',
    });
    return result.queued
      ? NextResponse.json(result)
      : NextResponse.json(result, { status: 409 });
  } catch (error) {
    return apiError(error, '启动单篇工作流失败');
  }
}
