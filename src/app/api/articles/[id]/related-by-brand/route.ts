import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getRelatedArticles } from '@/lib/article-related-service';

/**
 * GET /api/articles/[id]/related-by-brand?take=5
 * 查询与当前文章存在双向品牌/标题/摘要命中的近 30 天其它文章（最多 take 条）。
 *
 * 设计要点：
 * - 关联条件是对称的：任一文章的品牌出现在另一篇的 brand/title/summary 中，双方都可见。
 *   这样从 A 进入 B 后，B 仍能反向找到 A，不会形成单向关联。
 * - 即使当前文章没有 brand，也会通过当前文章的 title/summary 反向匹配候选品牌。
 * - brand 是 `|` 分隔字符串（最多 2 个，由 ai.ts 保证），server 端拆分后用 OR 拼接。
 * - 排除当前文章本身（id: { not: id }）。
 * - 时间窗口：publishedAt 优先，回退 createdAt（部分文章 publishedAt 为 null）；结果按同一有效时间排序。
 * - 仅 aiStatus IN ['done','failed']：详情页"相关动态"是导航提示，与推送契约（只看 done）解耦。
 *   failed 文章的 brand 字段可能仍有效（之前 AI 成功时写入），skipped 继续排除。
 * - 轻量返回：不带 source / pushLogs 关系，详情页已有 source 信息。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const rawTake = parseInt(url.searchParams.get('take') || '5', 10);
    const items = await getRelatedArticles(id, rawTake);
    if (items === null) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }
    return NextResponse.json({ items });
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch related articles');
  }
}
