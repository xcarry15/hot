import { splitBrands } from '@/lib/shared/article-codecs';
import { isRepresentativeEligible as isReleaseRepresentativeEligible } from '@/lib/event-release-policy';

export type RepresentativeCandidate = {
  id: string;
  clusterStatus: string;
  aiStatus: string;
  score: number;
  relevance: number;
  cleanContent: string;
  publishedAt: Date | null;
  createdAt: Date;
  source: { publicEnabled: boolean; deletedAt: Date | null };
};

export function eventDate(article: { publishedAt: Date | null; createdAt: Date }): Date {
  return article.publishedAt ?? article.createdAt;
}

export function sharedBrands(left: string, right: string): string[] {
  const rightBrands = new Set(splitBrands(right));
  return splitBrands(left).filter((brand) => rightBrands.has(brand));
}

export function compareArticleTime(
  left: { publishedAt: Date | null; createdAt: Date },
  right: { publishedAt: Date | null; createdAt: Date },
): number {
  const timeDiff = eventDate(right).getTime() - eventDate(left).getTime();
  if (timeDiff !== 0) return timeDiff;
  return right.createdAt.getTime() - left.createdAt.getTime();
}

export function deriveEventClusterReviewStatus(clusterStatuses: readonly string[]): 'confirmed' | 'pending' {
  return clusterStatuses.some((status) => status === 'needs_review') ? 'pending' : 'confirmed';
}

export function isRepresentativeEligible(article: RepresentativeCandidate): boolean {
  return isReleaseRepresentativeEligible(article);
}

export function selectRepresentativeCandidate(articles: RepresentativeCandidate[]): string | null {
  const ready = articles.filter(isReleaseRepresentativeEligible);
  ready.sort(compareRepresentative);
  return ready[0]?.id ?? null;
}

function compareRepresentative(left: RepresentativeCandidate, right: RepresentativeCandidate): number {
  const ready = Number(isReleaseRepresentativeEligible(right)) - Number(isReleaseRepresentativeEligible(left));
  if (ready !== 0) return ready;
  // 代表文章优先保留 Event 中最早发布的合格报道；其余指标只用于同日或时间相同的情况。
  const time = eventDate(left).getTime() - eventDate(right).getTime();
  if (time !== 0) return time;
  if (right.score !== left.score) return right.score - left.score;
  if (right.relevance !== left.relevance) return right.relevance - left.relevance;
  if (right.cleanContent.length !== left.cleanContent.length) return right.cleanContent.length - left.cleanContent.length;
  return left.createdAt.getTime() - right.createdAt.getTime();
}
