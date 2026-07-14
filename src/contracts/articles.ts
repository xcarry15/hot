/**
 * Article API 的纯 JSON 契约和序列化函数。
 *
 * 列表是摘要投影，详情才是完整投影；二者不能共用 select，避免列表把正文、
 * 内容哈希、重试与去重内部状态意外扩散到浏览器。
 */
import { maskWebhookTarget } from '@/lib/webhook-display';

export const ARTICLE_LIST_SELECT = {
  id: true,
  sourceId: true,
  url: true,
  title: true,
  originalSource: true,
  cleanContent: true,
  relevance: true,
  summary: true,
  brand: true,
  category: true,
  tags: true,
  score: true,
  aiStatus: true,
  skipReason: true,
  isAd: true,
  pushedAt: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ARTICLE_SCORE_SELECT = {
  eventScore: true,
  contentScore: true,
  rawScore: true,
  adProbability: true,
  aiConfidence: true,
} as const;

export const ARTICLE_DETAIL_SELECT = {
  ...ARTICLE_LIST_SELECT,
  ...ARTICLE_SCORE_SELECT,
  keyPoints: true,
  dedupDetail: true,
} as const;

type DateValue = Date | string;
type NullableDateValue = Date | string | null;

export interface ArticleListFieldsDto {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  originalSource: string | null;
  /** 列表摘要；正文仅在详情接口返回。 */
  excerpt: string;
  relevance: number;
  summary: string;
  brand: string;
  category: string;
  tags: string;
  score: number;
  aiStatus: string;
  skipReason: string | null;
  isAd: boolean;
  pushedAt: string | null;
  pushUrgency: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 详情返回正文预览、去重证据和评分诊断；抓取缓存与重试内部字段不出 API。 */
export interface ArticleFieldsDto extends ArticleListFieldsDto {
  cleanContent: string;
  keyPoints: string;
  dedupDetail: string | null;
  /** 评分明细（仅 AI 完成后有值） */
  eventScore: number | null;
  contentScore: number | null;
  rawScore: number | null;
  adProbability: number | null;
  aiConfidence: number | null;
}

export interface ArticleSourceSummaryDto {
  name: string;
  type: string;
}

export interface ArticleSourceDetailDto extends ArticleSourceSummaryDto {
  url: string;
}

export interface ArticlePushLogDto {
  id: string;
  articleId: string;
  status: string;
  errorMessage: string;
  retryCount: number;
  /** 仅供人工区分目标，永不返回可投递的完整 URL。 */
  webhookTarget: string;
  webhookRemark: string;
  createdAt: string;
}

export interface ArticleListItemDto extends ArticleListFieldsDto {
  source: ArticleSourceSummaryDto;
}

export interface ArticleDetailDto extends ArticleFieldsDto {
  source: ArticleSourceDetailDto;
  pushLogs: ArticlePushLogDto[];
}

export interface ArticlePaginationDto {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ArticleFacetDto {
  value: string;
  count: number;
}

export interface ArticleListResponseDto extends ArticlePaginationDto {
  items: ArticleListItemDto[];
  /** 全库筛选项，不受当前分页影响。 */
  facets: {
    categories: ArticleFacetDto[];
    brands: ArticleFacetDto[];
  };
}

type ListDates = {
  pushedAt: NullableDateValue;
  publishedAt: NullableDateValue;
  createdAt: DateValue;
  updatedAt: DateValue;
};

export type ArticleListRecord = Omit<
  ArticleListFieldsDto,
  'excerpt' | 'pushUrgency' | 'pushedAt' | 'publishedAt' | 'createdAt' | 'updatedAt'
> & ListDates & {
  cleanContent: string;
  source: ArticleSourceSummaryDto;
};

export type ArticleDetailRecord = Omit<
  ArticleFieldsDto,
  'excerpt' | 'pushUrgency' | 'pushedAt' | 'publishedAt' | 'createdAt' | 'updatedAt'
> & ListDates & {
  source: ArticleSourceDetailDto;
  pushLogs: ArticlePushLogRecord[];
};

export interface ArticlePushLogRecord {
  id: string;
  articleId: string;
  status: string;
  errorMessage: string;
  retryCount: number;
  webhookUrl: string;
  webhookRemark: string;
  createdAt: DateValue;
}

function toIso(value: NullableDateValue): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRequiredIso(value: DateValue): string {
  return toIso(value)!;
}

function toExcerpt(summary: string, cleanContent: string): string {
  if (summary) return summary;
  const text = cleanContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function serializeArticleListFields(
  article: Omit<ArticleListRecord, 'source'>,
): ArticleListFieldsDto {
  return {
    id: article.id,
    sourceId: article.sourceId,
    url: article.url,
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, article.cleanContent),
    relevance: article.relevance,
    summary: article.summary,
    brand: article.brand,
    category: article.category,
    tags: article.tags,
    score: article.score,
    aiStatus: article.aiStatus,
    skipReason: article.skipReason,
    isAd: article.isAd,
    pushedAt: toIso(article.pushedAt),
    // 紧急度是评分的派生状态，不读取可能过期的数据库缓存。
    pushUrgency: article.score >= 95 ? 'urgent' : 'normal',
    publishedAt: toIso(article.publishedAt),
    createdAt: toRequiredIso(article.createdAt),
    updatedAt: toRequiredIso(article.updatedAt),
  };
}

export function serializeArticleListItem(article: ArticleListRecord): ArticleListItemDto {
  return {
    ...serializeArticleListFields(article),
    source: article.source,
  };
}

export function serializeArticleDetail(article: ArticleDetailRecord): ArticleDetailDto {
  return {
    ...serializeArticleListFields(article),
    cleanContent: article.cleanContent,
    keyPoints: article.keyPoints,
    dedupDetail: article.dedupDetail,
    eventScore: article.eventScore ?? null,
    contentScore: article.contentScore ?? null,
    rawScore: article.rawScore ?? null,
    adProbability: article.adProbability ?? null,
    aiConfidence: article.aiConfidence ?? null,
    source: article.source,
    pushLogs: article.pushLogs.map((log) => ({
      id: log.id,
      articleId: log.articleId,
      status: log.status,
      errorMessage: log.errorMessage,
      retryCount: log.retryCount,
      webhookTarget: maskWebhookTarget(log.webhookUrl),
      webhookRemark: log.webhookRemark,
      createdAt: toRequiredIso(log.createdAt),
    })),
  };
}
