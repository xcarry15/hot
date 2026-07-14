import { NextResponse } from 'next/server';
import { reprocessWithAI } from '@/lib/ai';
import { apiError } from '@/lib/api-helpers';
import { runExclusiveMutation } from '@/lib/mutation-guard';

// POST /api/articles/reprocess - Re-run AI on an article
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { articleId } = body;

    if (!articleId) {
      return NextResponse.json({ error: 'Article ID is required' }, { status: 400 });
    }

    await runExclusiveMutation('单篇 AI 处理', () => reprocessWithAI(articleId));

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, 'Reprocess failed');
  }
}
