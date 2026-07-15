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

export interface PublicArticleSourceFacetDto {
  id: string;
  name: string;
  count: number;
}

export interface PublicArticleDateGroupDto {
  date: string;
  count: number;
  items: PublicArticleListItemDto[];
}

export interface PublicArticlePaginationDto {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PublicArticleListResponseDto extends PublicArticlePaginationDto {
  items: PublicArticleListItemDto[];
  groups: PublicArticleDateGroupDto[];
  pageStartDate: string | null;
  pageEndDate: string | null;
  sources: PublicArticleSourceFacetDto[];
  minScore: number;
}
