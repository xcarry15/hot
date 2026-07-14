import { NextResponse } from 'next/server';
import { pushArticleToFeishu } from '@/lib/push/delivery';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { apiError } from '@/lib/api-helpers';

// POST /api/push - Push one article synchronously.
// 批量推送统一走 /api/crawl 的 push 阶段，避免出现两套候选筛选入口。
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { articleId, force } = body;

    if (articleId) {
      const result = await runExclusiveMutation('单篇推送', () =>
        pushArticleToFeishu(articleId, !!force),
      );
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: '批量推送请使用抓取记录页的“推送”阶段' }, { status: 400 });
  } catch (error: unknown) {
    return apiError(error, 'Push failed');
  }
}
