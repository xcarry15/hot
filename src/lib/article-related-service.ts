import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { splitBrands } from '@/lib/shared/article-codecs';

const RELATED_WINDOW_DAYS = 30;

type RelatedArticleBase = {
  id: string;
  title: string;
  summary: string;
  score: number;
  createdAt: Date;
  publishedAt: Date | null;
  aiStatus: string;
  brand: string;
};

type RelatedEvent = {
  id: string;
  firstSeenAt: Date;
};

type RelatedCandidate = RelatedArticleBase & {
  url: string;
  eventId: string | null;
  source: { name: string; type: string };
  event: RelatedEvent | null;
  representedEvent: RelatedEvent | null;
};

export type RelatedArticle = {
  /** Article id for same-event reports, Event id for same-brand articles. */
  id: string;
  eventId: string | null;
  title: string;
  score: number;
  createdAt: Date;
  publishedAt: Date | null;
  url: string;
  source: { name: string; type: string };
  relation: 'same_event' | 'same_brand';
};

type RelatedVisibility = 'public' | 'pushed';

export interface RelatedArticleOptions {
  /** Retained for the Feishu delivery call site. */
  onlyPushed?: boolean;
  /** Public detail pages and pushed Feishu cards use different visibility gates. */
  visibility?: RelatedVisibility;
}

const relatedEventSelect = {
  id: true,
  firstSeenAt: true,
} as const;

const relatedCandidateSelect = {
  id: true,
  eventId: true,
  title: true,
  summary: true,
  url: true,
  brand: true,
  score: true,
  createdAt: true,
  publishedAt: true,
  aiStatus: true,
  source: { select: { name: true, type: true } },
  event: { select: relatedEventSelect },
  representedEvent: { select: relatedEventSelect },
} as const;

function effectiveTime(article: Pick<RelatedArticle, 'publishedAt' | 'createdAt'>): number {
  return (article.publishedAt ?? article.createdAt).getTime();
}

function compareByEffectiveTime(a: RelatedArticle, b: RelatedArticle): number {
  const timeDiff = effectiveTime(b) - effectiveTime(a);
  if (timeDiff !== 0) return timeDiff;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

function hasSharedBrand(article: RelatedArticleBase, candidate: RelatedArticleBase): boolean {
  const articleBrands = splitBrands(article.brand);
  const candidateBrands = splitBrands(candidate.brand);
  const candidateBrandSet = new Set(candidateBrands);
  return articleBrands.some((brand) => candidateBrandSet.has(brand));
}

function buildEventVisibilityWhere(options: RelatedArticleOptions): Prisma.EventWhereInput | null {
  const visibility = options.visibility ?? (options.onlyPushed ? 'pushed' : null);
  if (!visibility) return null;

  if (visibility === 'public') {
    return {
      status: 'active',
      clusterReviewStatus: 'confirmed',
      publicStatus: 'published',
      representativeArticleId: { not: null },
      representativeArticle: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
    };
  }

  return {
    status: 'active',
    pushedAt: { not: null },
    representativeArticleId: { not: null },
    representativeArticle: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
  };
}

function isWithinRecentWindow(date: Date, cutoff: Date): boolean {
  return date.getTime() >= cutoff.getTime();
}

function getCandidateRelation(
  article: RelatedArticleBase & { eventId: string | null },
  candidate: RelatedCandidate,
): RelatedArticle['relation'] | null {
  if (article.eventId && candidate.eventId === article.eventId) return 'same_event';
  if (candidate.representedEvent && hasSharedBrand(article, candidate)) return 'same_brand';
  return null;
}

function toRelatedArticle(
  candidate: RelatedCandidate,
  relation: RelatedArticle['relation'],
): RelatedArticle {
  const event = relation === 'same_event' ? candidate.event : candidate.representedEvent;
  return {
    id: relation === 'same_brand' && event ? event.id : candidate.id,
    eventId: event?.id ?? candidate.eventId,
    title: candidate.title,
    score: candidate.score,
    createdAt: relation === 'same_brand' && event ? event.firstSeenAt : candidate.createdAt,
    publishedAt: candidate.publishedAt,
    url: candidate.url,
    source: candidate.source,
    relation,
  };
}

/**
 * Return all other articles from the same Event and same-brand Events in the
 * recent 30-day window. Both public pages and Feishu cards use this service so
 * their recent-article sections cannot drift apart.
 */
export async function getRelatedArticles(
  id: string,
  requestedTake?: number,
  options: RelatedArticleOptions = {},
): Promise<RelatedArticle[] | null> {
  const article = await db.article.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      summary: true,
      brand: true,
      score: true,
      createdAt: true,
      publishedAt: true,
      aiStatus: true,
      eventId: true,
    },
  });
  if (!article) return null;

  const brands = splitBrands(article.brand);
  const cutoff = new Date(Date.now() - RELATED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const eventVisibilityWhere = buildEventVisibilityWhere(options);
  const sameEventBranch: Prisma.ArticleWhereInput | null = article.eventId
    ? {
        eventId: article.eventId,
        ...(eventVisibilityWhere ? { event: { is: eventVisibilityWhere } } : {}),
      }
    : null;
  const brandBranches: Prisma.ArticleWhereInput[] = brands.map((brand) => ({
    brand: { contains: brand },
  })).map((branch) => ({
    ...branch,
    ...(eventVisibilityWhere ? { representedEvent: { is: eventVisibilityWhere } } : {}),
  }));

  const relationBranches = [
    ...(sameEventBranch ? [sameEventBranch] : []),
    ...(brandBranches.length > 0 ? brandBranches : []),
  ];
  if (relationBranches.length === 0) return [];

  const candidates = await db.article.findMany({
    where: {
      id: { not: id },
      AND: [
        { OR: relationBranches },
        {
          OR: [
            { publishedAt: { gte: cutoff } },
            { publishedAt: null, createdAt: { gte: cutoff } },
            { event: { is: { firstSeenAt: { gte: cutoff } } } },
            { representedEvent: { is: { firstSeenAt: { gte: cutoff } } } },
          ],
        },
      ],
    },
    select: relatedCandidateSelect,
  });

  const related = candidates
    .map((candidate) => {
      const relation = getCandidateRelation(article, candidate);
      return relation ? toRelatedArticle(candidate, relation) : null;
    })
    .filter((candidate): candidate is RelatedArticle => Boolean(candidate))
    .filter((candidate) => isWithinRecentWindow(candidate.publishedAt ?? candidate.createdAt, cutoff))
    .sort(compareByEffectiveTime);

  const take = typeof requestedTake === 'number' && Number.isFinite(requestedTake) && requestedTake > 0
    ? Math.floor(requestedTake)
    : null;
  return take ? related.slice(0, take) : related;
}
