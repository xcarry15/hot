/**
 * /api/articles Route 适配器。
 *
 * 只保留：解析 query/body → 调用 article-service 用例 → 映射响应。
 * 任何 where 拼装、事务、批处理、worker 调用都不得在此文件中实现。
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import {
  deleteArticlesByFilter,
  deleteArticlesByIds,
  listArticles,
} from '@/lib/article-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { parsePositiveInt } from '@/lib/pagination';

// GET /api/articles - List articles with filters and pagination
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {
      aiStatus: searchParams.get('status') ?? undefined,
      brandContains: searchParams.get('brand') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      minScore: parseOptionalInt(searchParams.get('minScore')),
      minRelevance: parseOptionalInt(searchParams.get('minRelevance')),
      sourceId: searchParams.get('sourceId') ?? undefined,
      search: searchParams.get('search') ?? undefined,
    };
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 100);

    return NextResponse.json(await listArticles({ filter, page, pageSize }));
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch articles');
  }
}

// DELETE /api/articles - Batch delete articles
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const ids = searchParams.get('ids');

    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      return NextResponse.json(await runExclusiveMutation('批量删除文章', () => deleteArticlesByIds(idList)));
    }

    const filter = {
      aiStatus: searchParams.get('status') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      maxScore: parseOptionalInt(searchParams.get('maxScore')),
    };
    if (Object.values(filter).every((value) => value === undefined)) {
      return NextResponse.json({ error: '删除全部文章请使用维护页的明确操作' }, { status: 400 });
    }
    return NextResponse.json(await runExclusiveMutation('按条件删除文章', () => deleteArticlesByFilter(filter)));
  } catch (error: unknown) {
    return apiError(error, 'Failed to delete articles');
  }
}

/** 解析整数 query；空值/非数字返回 NaN，让调用方判空。 */
function parseOptionalInt(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}
