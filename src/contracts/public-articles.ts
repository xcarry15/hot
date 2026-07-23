/**
 * Public article contract.
 *
 * This contract is intentionally separate from the admin article DTO. The
 * public portal must not expose push logs, dedup evidence, AI diagnostics, or
 * pipeline status fields.
 */

export interface PublicArticleSourceDto {
  id: string;
  name: string;
  type: string;
}

export interface PublicArticleListItemDto {
  id: string;
  title: string;
  originalSource: string | null;
  excerpt: string;
  brand: string;
  category: string;
  score: number;
  publishedAt: string | null;
  createdAt: string;
  sourceCount: number;
  source: PublicArticleSourceDto;
}

export interface PublicArticleRelatedDto {
  id: string;
  title: string;
  score: number;
  publishedAt: string | null;
  createdAt: string;
  source: Pick<PublicArticleSourceDto, 'name' | 'type'>;
}

export interface PublicArticleNavigationItemDto {
  id: string;
  title: string;
}

export interface PublicArticleDetailDto extends PublicArticleListItemDto {
  url: string;
  summary: string;
  keyPoints: string[];
  sources: Array<{
    id: string;
    title: string;
    url: string;
    publishedAt: string | null;
    createdAt: string;
    source: Pick<PublicArticleSourceDto, 'name' | 'type'>;
  }>;
  related: PublicArticleRelatedDto[];
  navigation: {
    previous: PublicArticleNavigationItemDto | null;
    next: PublicArticleNavigationItemDto | null;
  };
}

export interface PublicArticleDateGroupDto {
  date: string;
  count: number;
  items: PublicArticleListItemDto[];
}

export interface PublicArticleListResponseDto {
  total: number;
  groups: PublicArticleDateGroupDto[];
  displayedArticleCount: number;
  displayedDateCount: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PublicArticleFeedRevisionDto {
  total: number;
}
