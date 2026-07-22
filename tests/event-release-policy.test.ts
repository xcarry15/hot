import { describe, expect, it } from 'vitest';
import { getEventReleaseBlockReason, isRepresentativeEligible } from '@/lib/event-release-policy';

const readyArticle = {
  clusterStatus: 'clustered',
  aiStatus: 'done',
  source: { deletedAt: null },
};

describe('Event 对外释放基础门禁', () => {
  it('代表文章必须完成聚类、AI 且来源未删除', () => {
    expect(isRepresentativeEligible(readyArticle)).toBe(true);
    expect(isRepresentativeEligible({ ...readyArticle, clusterStatus: 'needs_review' })).toBe(false);
    expect(isRepresentativeEligible({ ...readyArticle, aiStatus: 'pending' })).toBe(false);
    expect(isRepresentativeEligible({ ...readyArticle, source: { deletedAt: new Date() } })).toBe(false);
  });

  it('公开与推送必须使用 active confirmed Event 的当前代表文章', () => {
    const event = { status: 'active', clusterReviewStatus: 'confirmed', representativeArticleId: 'a1' };
    expect(getEventReleaseBlockReason(event, 'a1', readyArticle)).toBeNull();
    expect(getEventReleaseBlockReason({ ...event, clusterReviewStatus: 'pending' }, 'a1', readyArticle)).toBe('event-needs-review');
    expect(getEventReleaseBlockReason(event, 'a2', readyArticle)).toBe('article-not-representative');
  });
});
