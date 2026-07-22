/**
 * Event 对外释放策略。
 *
 * 这里只保存不读数据库的基础完整性规则，供代表文章、公开和推送共同复用。
 * 分数、相关度、软文、自动开关等渠道策略仍由 Publication / Delivery 各自负责。
 */

export interface EventReleaseArticle {
  clusterStatus: string;
  aiStatus: string;
  source: {
    deletedAt: Date | null;
  };
}

export interface EventReleaseContext {
  status: string;
  clusterReviewStatus: string;
  representativeArticleId: string | null;
}

export type EventReleaseBlockReason =
  | 'event-not-active'
  | 'event-needs-review'
  | 'representative-missing'
  | 'article-not-representative'
  | 'cluster-not-done'
  | 'ai-not-done'
  | 'source-deleted';

export function getRepresentativeBlockReason(article: EventReleaseArticle): EventReleaseBlockReason | null {
  if (article.clusterStatus !== 'clustered') return 'cluster-not-done';
  if (article.aiStatus !== 'done') return 'ai-not-done';
  if (article.source.deletedAt !== null) return 'source-deleted';
  return null;
}

export function isRepresentativeEligible(article: EventReleaseArticle): boolean {
  return getRepresentativeBlockReason(article) === null;
}

export function getEventReleaseBlockReason(
  event: EventReleaseContext,
  articleId: string,
  article: EventReleaseArticle,
): EventReleaseBlockReason | null {
  if (event.status !== 'active') return 'event-not-active';
  if (event.clusterReviewStatus !== 'confirmed') return 'event-needs-review';
  if (!event.representativeArticleId) return 'representative-missing';
  if (event.representativeArticleId !== articleId) return 'article-not-representative';
  return getRepresentativeBlockReason(article);
}
