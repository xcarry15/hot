import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { getArticleDetail, deleteArticleById, updateArticleEditorial } from '@/lib/article-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { MANUAL_OVERRIDE_FIELDS, type ManualOverrideField } from '@/lib/article-calibration';

function scoreValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const publicOverride = body.publicOverride === 'auto' || body.publicOverride === 'public' || body.publicOverride === 'hidden'
      ? body.publicOverride
      : undefined;
    const article = await runExclusiveMutation('编辑文章', () => updateArticleEditorial(id, {
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      tags: Array.isArray(body.tags) ? body.tags.filter((item): item is { name: string; tone?: string } => Boolean(item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')) : undefined,
      keyPoints: Array.isArray(body.keyPoints) ? body.keyPoints.filter((item): item is string => typeof item === 'string') : undefined,
      publicOverride,
      relevance: scoreValue(body.relevance) ?? undefined,
      eventScore: scoreValue(body.eventScore),
      contentScore: scoreValue(body.contentScore),
      adProbability: scoreValue(body.adProbability),
      isAd: typeof body.isAd === 'boolean' ? body.isAd : undefined,
      restoreFields: Array.isArray(body.restoreFields)
        ? body.restoreFields.filter((item): item is ManualOverrideField => typeof item === 'string' && MANUAL_OVERRIDE_FIELDS.includes(item as ManualOverrideField))
        : undefined,
    }));
    if (!article) return NextResponse.json({ error: '文章不存在' }, { status: 404 });
    return NextResponse.json(article);
  } catch (error: unknown) {
    return apiError(error, 'Failed to update article');
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
