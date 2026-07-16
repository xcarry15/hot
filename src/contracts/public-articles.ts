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
  url: string;
  title: string;
  originalSource: string | null;
  excerpt: string;
  summary: string;
  brand: string;
  category: string;
  tags: string;
  score: number;
  publishedAt: string | null;
  createdAt: string;
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

export interface PublicArticleDetailDto extends PublicArticleListItemDto {
  keyPoints: string[];
  contentPreview: string;
  related: PublicArticleRelatedDto[];
}

export interface PublicArticleDateGroupDto {
  date: string;
  count: number;
  items: PublicArticleListItemDto[];
}

export interface PublicArticleListResponseDto {
  total: number;
  items: PublicArticleListItemDto[];
  groups: PublicArticleDateGroupDto[];
  displayedArticleCount: number;
  displayedDateCount: number;
  nextDate: string | null;
  hasMore: boolean;
}

export interface PublicArticleFeedRevisionDto {
  total: number;
}
