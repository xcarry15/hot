import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getDiscardedItem } from '@/lib/discarded-service';

/**
 * GET /api/discarded/[id]
 *
 * 返回未入库条目（DiscardedItem）的详情，供抓取记录页面的详情面板使用。
 * discarded 表只保留元数据（标题/URL/原因），无正文/AI 字段。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const item = await getDiscardedItem(id);

    if (!item) {
      return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    }

    return NextResponse.json(item);
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch discarded item');
  }
}
