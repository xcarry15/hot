import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { retryDiscardedItem } from '@/lib/discarded-retry-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

/**
 * POST /api/discarded/retry
 *
 * 将一条被关键词过滤的 DiscardedItem 强制采集为 Article。
 * 创建后文章状态为 pending，后续 process/ai/push 流水线自然接管。
 *
 * Body: { id: string }  — DiscardedItem 的主键
 * Response: { success: true, articleId, title, auditId }
 */
export async function POST(request: Request) {
  try {
    const { id } = (await request.json()) as { id?: string };
    if (!id) {
      return NextResponse.json({ error: '缺少 id 参数' }, { status: 400 });
    }

    const result = await runExclusiveMutation('重试未入库条目', () => retryDiscardedItem(id));
    if (result.kind === 'not_found') {
      return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    }
    if (result.kind === 'invalid_reason') {
      return NextResponse.json(
        { error: `不支持重试此类型的条目，当前原因: ${result.reason}` },
        { status: 400 },
      );
    }
    return NextResponse.json({
      success: true,
      articleId: result.articleId,
      title: result.title,
      auditId: result.auditId,
      ...(result.kind === 'existing' ? { existed: true } : {}),
    });
  } catch (error: unknown) {
    return apiError(error, '采集失败');
  }
}
