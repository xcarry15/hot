import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getArticleDetail, deleteArticleById } from '@/lib/article-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// GET /api/articles/[id] - Get article detail
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const article = await getArticleDetail(id);

    if (!article) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }

    return NextResponse.json(article);
  } catch (error: unknown) {
    return apiError(error, 'Failed to fetch article');
  }
}

// DELETE /api/articles/[id] - Delete an article
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await runExclusiveMutation('删除文章', () => deleteArticleById(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, 'Failed to delete article');
  }
}
