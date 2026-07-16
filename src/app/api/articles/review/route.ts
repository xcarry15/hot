import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { reviewArticle, reviewArticles, REVIEW_REASON_TAGS, REVIEW_STATUSES } from '@/lib/review-service';
import { runExclusiveMutation } from '@/lib/mutation-guard';
import { runJob } from '@/lib/execution';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const articleId = typeof body.articleId === 'string' ? body.articleId : '';
    const articleIds = Array.isArray(body.articleIds)
      ? body.articleIds.slice(0, 100).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const status = typeof body.status === 'string' ? body.status : '';
    if ((!articleId && articleIds.length === 0) || !REVIEW_STATUSES.includes(status as typeof REVIEW_STATUSES[number])) {
      return NextResponse.json({ error: 'articleId 和有效归类状态为必填项' }, { status: 400 });
    }
    const reasonTags = Array.isArray(body.reasonTags)
      ? body.reasonTags.filter((tag): tag is string => typeof tag === 'string' && REVIEW_REASON_TAGS.includes(tag as typeof REVIEW_REASON_TAGS[number]))
      : [];
    if (articleIds.length > 0) {
      const result = await runExclusiveMutation('文章归类', () => reviewArticles({
        articleIds,
        status: status as typeof REVIEW_STATUSES[number],
        reasonTags,
      }));
      const aiQueued = result.restoredDuplicateIds.length > 0
        ? (await runJob('ai', { trigger: 'manual', reason: 'batch-review-restore-duplicate', articleIds: result.restoredDuplicateIds })).queued
        : false;
      return NextResponse.json({ ...result, aiQueued });
    }
    const result = await runExclusiveMutation('文章归类', () => reviewArticle({
      articleId,
      status: status as typeof REVIEW_STATUSES[number],
      reasonTags,
    }));
    if (!result) return NextResponse.json({ error: '文章不存在' }, { status: 404 });
    const aiQueued = result.restoredDuplicate
      ? (await runJob('ai', { trigger: 'manual', reason: 'review-restore-duplicate', articleId })).queued
      : false;
    return NextResponse.json({ ...result, aiQueued });
  } catch (error: unknown) {
    return apiError(error, 'Failed to review article');
  }
}
