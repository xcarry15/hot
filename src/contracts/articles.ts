/**
 * Article API 的纯 JSON 契约和序列化函数。
 *
 * 列表是摘要投影，详情才是完整投影；二者不能共用 select，避免列表把正文、
 * 内容哈希、重试与去重内部状态意外扩散到浏览器。
 */
import { maskWebhookTarget } from '@/lib/webhook-display';

const ARTICLE_SCORE_SELECT = {
  eventScore: true,
  contentScore: true,
  rawScore: true,
  adProbability: true,
} as const;

export const ARTICLE_LIST_SELECT = {
  eventId: true,
  clusterStatus: true,
  clusteredAt: true,
  eventSubjects: true,
  eventAction: true,
  eventObject: true,
  eventKey: true,
  eventKeyConfidence: true,
  eventScore: true,
  contentScore: true,
  adProbability: true,
  id: true,
  sourceId: true,
  url: true,
  title: true,
  originalSource: true,
  relevance: true,
  summary: true,
  brand: true,
  category: true,
  score: true,
  aiConfidence: true,
  aiStatus: true,
  fetchStatus: true,
  fetchError: true,
  aiError: true,
  clusterError: true,
  skipReason: true,
  isAd: true,
  reviewStatus: true,
  reviewReasonTags: true,
  reviewedAt: true,
  publicOverride: true,
  publicStatus: true,
  publicPublicationReason: true,
  pinUntil: true,
  aiSnapshot: true,
  manualOverrides: true,
  manualCorrectedAt: true,
  viewCount: true,
  originalClickCount: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  event: {
    select: {
      id: true,
      articleCount: true,
      representativeArticleId: true,
      pushedAt: true,
    },
  },
} as const;

export const ARTICLE_DETAIL_SELECT = {
  ...ARTICLE_LIST_SELECT,
  ...ARTICLE_SCORE_SELECT,
  cleanContent: true,
  keyPoints: true,
} as const;

type DateValue = Date | string;
type NullableDateValue = Date | string | null;

export interface ArticleListFieldsDto {
  id: string;
  eventId: string | null;
  clusterStatus: string;
  clusteredAt: string | null;
  eventSubjects: string;
  eventAction: string;
  eventObject: string;
  eventKey: string;
  eventKeyConfidence: number | null;
  event: {
    id: string;
    articleCount: number;
    representativeArticleId: string | null;
    pushedAt: string | null;
  } | null;
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
  score: number;
  /** 评分构成（仅 AI 完成后有值） */
  eventScore: number | null;
  contentScore: number | null;
  adProbability: number | null;
  aiConfidence: number | null;
  aiStatus: string;
  fetchStatus: string;
  /** 各流程阶段最近一次失败原因；成功或未失败时为 null。 */
  fetchError: string | null;
  aiError: string | null;
  clusterError: string | null;
  skipReason: string | null;
  isAd: boolean;
  reviewStatus: string;
  reviewReasonTags: string;
  reviewedAt: string | null;
  publicOverride: string;
  publicStatus: string;
  publicPublicationReason: string;
  pinUntil: string | null;
  aiSnapshot: string;
  manualOverrides: string;
  manualCorrectedAt: string | null;
  viewCount: number;
  originalClickCount: number;
  pushedAt: string | null;
  pushUrgency: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 详情返回正文预览和评分诊断；抓取缓存与重试内部字段不出 API。 */
export interface ArticleFieldsDto extends ArticleListFieldsDto {
  cleanContent: string;
  keyPoints: string;
  rawScore: number | null;
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

export interface ArticleListResponseDto extends ArticlePaginationDto {
  items: ArticleListItemDto[];
}

type ListDates = {
  publishedAt: NullableDateValue;
  reviewedAt: NullableDateValue;
  manualCorrectedAt: NullableDateValue;
  pinUntil: NullableDateValue;
  createdAt: DateValue;
  updatedAt: DateValue;
  clusteredAt: NullableDateValue;
};

export type ArticleListRecord = Omit<
  ArticleListFieldsDto,
  'excerpt' | 'pushUrgency' | 'pushedAt' | 'publishedAt' | 'reviewedAt' | 'manualCorrectedAt' | 'pinUntil' | 'clusteredAt' | 'event' | 'createdAt' | 'updatedAt'
> & ListDates & {
  cleanContent?: string;
  source: ArticleSourceSummaryDto;
  event: {
    id: string;
    articleCount: number;
    representativeArticleId: string | null;
    pushedAt: NullableDateValue;
  } | null;
};

export type ArticleDetailRecord = Omit<
  ArticleFieldsDto,
  'excerpt' | 'pushUrgency' | 'pushedAt' | 'publishedAt' | 'reviewedAt' | 'manualCorrectedAt' | 'pinUntil' | 'clusteredAt' | 'event' | 'createdAt' | 'updatedAt'
> & ListDates & {
  source: ArticleSourceDetailDto;
  pushLogs: ArticlePushLogRecord[];
  event: {
    id: string;
    articleCount: number;
    representativeArticleId: string | null;
    pushedAt: NullableDateValue;
  } | null;
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

function toExcerpt(summary: string, cleanContent = ''): string {
  if (summary) return summary;
  const text = cleanContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function serializeArticleListFields(
  article: Omit<ArticleListRecord, 'source'>,
): ArticleListFieldsDto {
  return {
    id: article.id,
    eventId: article.eventId,
    clusterStatus: article.clusterStatus,
    clusteredAt: toIso(article.clusteredAt),
    eventSubjects: article.eventSubjects,
    eventAction: article.eventAction,
    eventObject: article.eventObject,
    eventKey: article.eventKey,
    eventKeyConfidence: article.eventKeyConfidence,
    event: article.event ? {
      ...article.event,
      pushedAt: toIso(article.event.pushedAt),
    } : null,
    sourceId: article.sourceId,
    url: article.url,
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, article.cleanContent),
    relevance: article.relevance,
    summary: article.summary,
    brand: article.brand,
    category: article.category,
    score: article.score,
    eventScore: article.eventScore ?? null,
    contentScore: article.contentScore ?? null,
    adProbability: article.adProbability ?? null,
    aiConfidence: article.aiConfidence ?? null,
    aiStatus: article.aiStatus,
    fetchStatus: article.fetchStatus,
    fetchError: article.fetchError,
    aiError: article.aiError,
    clusterError: article.clusterError,
    skipReason: article.skipReason,
    isAd: article.isAd,
    reviewStatus: article.reviewStatus,
    reviewReasonTags: article.reviewReasonTags,
    reviewedAt: toIso(article.reviewedAt),
    publicOverride: article.publicOverride,
    publicStatus: article.publicStatus,
    publicPublicationReason: article.publicPublicationReason,
    pinUntil: toIso(article.pinUntil),
    aiSnapshot: article.aiSnapshot,
    manualOverrides: article.manualOverrides,
    manualCorrectedAt: toIso(article.manualCorrectedAt),
    viewCount: article.viewCount,
    originalClickCount: article.originalClickCount,
    pushedAt: toIso(article.event?.pushedAt ?? null),
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
    rawScore: article.rawScore ?? null,
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
