import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { runJob, validateBatchArticleRegeneration } from '@/lib/execution';

/** POST /api/articles/batch-workflow - 批量重跑低分析置信文章的 AI 与聚类。 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const articleIds = Array.isArray(body.articleIds)
      ? body.articleIds.filter((value): value is string => typeof value === 'string')
      : [];
    const validation = await validateBatchArticleRegeneration(articleIds);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: validation.status });
    }

    const result = await runJob('ai', {
      articleIds: validation.articleIds,
      trigger: 'manual',
    });
    return result.queued
      ? NextResponse.json({ ...result, count: validation.articleIds.length })
      : NextResponse.json(result, { status: 409 });
  } catch (error) {
    return apiError(error, '批量重跑 AI 失败');
  }
}
