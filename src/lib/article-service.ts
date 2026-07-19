/**
 * Article 应用服务。
 *
 * 负责把 `/api/articles` 系列路由的业务逻辑抽离：
 *   - listArticles：分页 + 多条件筛选 + Source 摘要关联
 *   - getArticleDetail：详情 + 最近推送日志
 *   - deleteArticleById / deleteArticlesByIds / deleteArticlesByFilter
 *
 * 设计约束：
 *   - 不依赖 Next.js Request / Response；
 *   - 不修改 endpoint、字段名、分页或排序；
 *   - 删除事务顺序与原 Route 完全一致（pushLog → article）；
 *   - 不建立通用 Repository；与 maintenance-service 各保留本地事务 helper。
 */
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  ARTICLE_DETAIL_SELECT,
  ARTICLE_LIST_SELECT,
  serializeArticleDetail,
  serializeArticleListItem,
  type ArticleDetailDto,
  type ArticleListResponseDto,
} from '@/contracts/articles';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshPublicPublication } from '@/lib/public-publication-service';
import { getAISettings } from '@/lib/ai-client';
import {
  buildEffectiveScoreUpdate,
  buildManualOverrideUpdate,
  parseArticleAiSnapshot,
  type ManualOverrideField,
} from '@/lib/article-calibration';
import { recalculateArticleEvent, reconcileEventAfterArticleDeletion } from '@/lib/event-service';

// ── 类型化筛选器 ────────────────────────────────────────────────

/**
 * 列表筛选：可空字段要么完全省略，要么按规则构造 where 条件。
 * search 同时作用于 title / summary / brand（OR）。
 */
export interface ArticleListFilter {
  aiStatus?: string;
  brandContains?: string;
  category?: string;
  minScore?: number;
  minRelevance?: number;
  maxConfidence?: number;
  sourceId?: string;
  search?: string;
  reviewStatus?: string;
  fetchStatus?: string;
  inbox?: boolean;
  anomaly?: 'needs_attention' | 'technical';
  clusterView?: 'needs_review' | 'multi_source' | 'representative';
  manualOnly?: boolean;
  sort?: 'newest' | 'oldest' | 'score_desc' | 'score_asc' | 'relevance_desc' | 'relevance_asc' | 'event_desc' | 'event_asc' | 'content_desc' | 'content_asc' | 'ad_desc' | 'ad_asc' | 'confidence_desc' | 'confidence_asc';
}

export function buildArticleListWhere(filter: ArticleListFilter): Prisma.ArticleWhereInput {
  const where: Prisma.ArticleWhereInput = {};
  if (filter.aiStatus) where.aiStatus = filter.aiStatus;
  if (filter.brandContains) where.brand = { contains: filter.brandContains };
  if (filter.category) where.category = filter.category;
  if (Number.isFinite(filter.minScore)) where.score = { gte: filter.minScore };
  if (Number.isFinite(filter.minRelevance)) where.relevance = { gte: filter.minRelevance };
  if (Number.isFinite(filter.maxConfidence)) where.aiConfidence = { lt: filter.maxConfidence };
  if (filter.sourceId) where.sourceId = filter.sourceId;
  if (filter.reviewStatus) where.reviewStatus = filter.reviewStatus;
  if (filter.fetchStatus) where.fetchStatus = filter.fetchStatus as 'pending' | 'fetched' | 'failed';
  if (filter.inbox) {
    where.fetchStatus = 'fetched';
    where.reviewStatus = 'unreviewed';
  }
  if (filter.anomaly === 'needs_attention') {
    where.OR = [
      { clusterStatus: 'needs_review' },
      { aiStatus: 'done', aiConfidence: { lt: 70 } },
      { reviewStatus: 'unreviewed' },
    ];
  }
  if (filter.anomaly === 'technical') {
    where.technicalIgnoredAt = null;
    where.OR = [
      { fetchStatus: 'failed' },
      { aiStatus: 'failed' },
      { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
      { clusterStatus: 'failed' },
    ];
  }
  if (filter.clusterView === 'needs_review') where.clusterStatus = 'needs_review';
  if (filter.clusterView === 'multi_source') where.event = { is: { status: 'active', articleCount: { gt: 1 } } };
  if (filter.clusterView === 'representative') where.representedEvent = { is: { status: 'active' } };
  if (filter.manualOnly) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { NOT: { manualOverrides: '[]' } },
    ];
  }
  if (filter.anomaly) {
    const attention = where.OR ?? [];
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: attention },
    ];
    delete where.OR;
  }
  if (filter.search) {
    const searchWhere: Prisma.ArticleWhereInput = { OR: [
      { title: { contains: filter.search } },
      { summary: { contains: filter.search } },
      { brand: { contains: filter.search } },
    ] };
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), searchWhere];
  }
  return where;
}

/**
 * 删除筛选（DELETE 无 ids 时使用），与列表筛选语义不同：
 * 只看 status / category / maxScore（保留"按状态批量删"和"低分全清"语义）。
 */
export interface ArticleDeleteFilter {
  aiStatus?: string;
  category?: string;
  maxScore?: number;
}

export function buildArticleDeleteWhere(filter: ArticleDeleteFilter): Prisma.ArticleWhereInput {
  const where: Prisma.ArticleWhereInput = {};
  if (filter.aiStatus) where.aiStatus = filter.aiStatus;
  if (filter.category) where.category = filter.category;
  if (Number.isFinite(filter.maxScore)) where.score = { lte: filter.maxScore };
  return where;
}

// ── 列表与详情 ──────────────────────────────────────────────────

export interface ListArticlesParams {
  filter?: ArticleListFilter;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 列表：where + 分页 + 摘要 DTO 序列化 + 计数。
 * 顺序：publishedAt desc, createdAt desc；分页上限 100。
 */
export async function listArticles(
  params: ListArticlesParams = {},
): Promise<ArticleListResponseDto> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
  const where = buildArticleListWhere(params.filter ?? {});

  const [items, total] = await Promise.all([
    db.article.findMany({
      where,
      select: {
        ...ARTICLE_LIST_SELECT,
        source: { select: { name: true, type: true } },
      },
      orderBy: params.filter?.sort === 'oldest'
        ? [{ publishedAt: 'asc' }, { createdAt: 'asc' }]
        : params.filter?.sort === 'score_desc'
          ? [{ score: 'desc' }, { createdAt: 'desc' }]
          : params.filter?.sort === 'score_asc'
            ? [{ score: 'asc' }, { createdAt: 'desc' }]
            : params.filter?.sort === 'relevance_desc'
              ? [{ relevance: 'desc' }, { createdAt: 'desc' }]
              : params.filter?.sort === 'relevance_asc'
                ? [{ relevance: 'asc' }, { createdAt: 'desc' }]
                : params.filter?.sort === 'event_desc'
                  ? [{ eventScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
                  : params.filter?.sort === 'event_asc'
                    ? [{ eventScore: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
                    : params.filter?.sort === 'content_desc'
                      ? [{ contentScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
                      : params.filter?.sort === 'content_asc'
                        ? [{ contentScore: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
                        : params.filter?.sort === 'ad_desc'
                          ? [{ adProbability: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
                          : params.filter?.sort === 'ad_asc'
                            ? [{ adProbability: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
                            : params.filter?.sort === 'confidence_desc'
                              ? [{ aiConfidence: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
                              : params.filter?.sort === 'confidence_asc'
                                ? [{ aiConfidence: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
                                : params.filter?.inbox
                                  ? [{ createdAt: 'asc' }]
                                  : [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.article.count({ where }),
  ]);

  return {
    items: items.map(serializeArticleListItem),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export interface UpdateArticleEditorialInput {
  summary?: string;
  brand?: string;
  category?: string;
  tags?: Array<{ name: string; tone?: string }>;
  keyPoints?: string[];
  publicOverride?: 'auto' | 'public' | 'hidden';
  relevance?: number;
  eventScore?: number | null;
  contentScore?: number | null;
  adProbability?: number | null;
  isAd?: boolean;
  restoreFields?: ManualOverrideField[];
}

function cleanScore(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function cleanText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().slice(0, max);
}

function isRestorableSnapshotValue(field: ManualOverrideField, value: unknown): value is string | number | boolean {
  if (['relevance', 'eventScore', 'contentScore', 'adProbability'].includes(field)) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (field === 'isAd') return typeof value === 'boolean';
  return typeof value === 'string';
}

/** 保存人工纠错或单篇公开状态，并同步持久化公开快照。 */
export async function updateArticleEditorial(id: string, input: UpdateArticleEditorialInput): Promise<ArticleDetailDto | null> {
  const current = await db.article.findUnique({
    where: { id },
    select: {
      id: true,
      summary: true,
      brand: true,
      category: true,
      tags: true,
      keyPoints: true,
      relevance: true,
      eventScore: true,
      contentScore: true,
      adProbability: true,
      isAd: true,
      manualOverrides: true,
      aiSnapshot: true,
    },
  });
  if (!current) return null;
  const data: Prisma.ArticleUpdateInput = {};
  const touched: ManualOverrideField[] = [];
  const restored = input.restoreFields ?? [];
  const snapshot = parseArticleAiSnapshot(current.aiSnapshot);
  const summary = cleanText(input.summary, 10_000);
  const category = cleanText(input.category, 100);
  if (summary !== undefined) { data.summary = summary; touched.push('summary'); }
  if (category !== undefined) { data.category = category; touched.push('category'); }
  if (input.brand !== undefined) { data.brand = JSON.stringify(splitBrands(input.brand).slice(0, 20)); touched.push('brand'); }
  if (input.tags !== undefined) { data.tags = JSON.stringify(input.tags.slice(0, 30).map((tag) => ({ n: tag.name.trim().slice(0, 50), t: (tag.tone || '中').trim().slice(0, 10) })).filter((tag) => tag.n)); touched.push('tags'); }
  if (input.keyPoints !== undefined) { data.keyPoints = JSON.stringify(input.keyPoints.map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20)); touched.push('keyPoints'); }
  if (input.publicOverride !== undefined) data.publicOverride = input.publicOverride;
  const relevance = cleanScore(input.relevance);
  const eventScore = cleanScore(input.eventScore);
  const contentScore = cleanScore(input.contentScore);
  const adProbability = cleanScore(input.adProbability);
  if (typeof relevance === 'number') { data.relevance = relevance; touched.push('relevance'); }
  if (typeof eventScore === 'number') { data.eventScore = eventScore; touched.push('eventScore'); }
  if (typeof contentScore === 'number') { data.contentScore = contentScore; touched.push('contentScore'); }
  if (typeof adProbability === 'number') { data.adProbability = adProbability; touched.push('adProbability'); }
  if (input.isAd !== undefined) { data.isAd = input.isAd; touched.push('isAd'); }

  const validRestored = restored.filter((field) => isRestorableSnapshotValue(field, snapshot[field]));
  for (const field of validRestored) {
    const value = snapshot[field];
    data[field] = value as never;
  }

  const nextEventScore = typeof data.eventScore === 'number' ? data.eventScore : current.eventScore;
  const nextContentScore = typeof data.contentScore === 'number' ? data.contentScore : current.contentScore;
  const nextAdProbability = typeof data.adProbability === 'number' ? data.adProbability : current.adProbability;
  const nextIsAd = typeof data.isAd === 'boolean' ? data.isAd : current.isAd;
  if (nextEventScore != null && nextContentScore != null && nextAdProbability != null) {
    const { weightEvent, weightContent } = await getAISettings();
    Object.assign(data, buildEffectiveScoreUpdate({
      eventScore: nextEventScore,
      contentScore: nextContentScore,
      adProbability: nextAdProbability,
      isAd: nextIsAd,
      weightEvent,
      weightContent,
    }));
  }
  Object.assign(data, buildManualOverrideUpdate(current.manualOverrides, touched, validRestored));
  const contentChanged = touched.some((field) => ['summary', 'brand', 'category', 'tags', 'keyPoints'].includes(field))
    || validRestored.some((field) => ['summary', 'brand', 'category', 'tags', 'keyPoints'].includes(field));
  await db.$transaction(async (tx) => {
    await tx.article.update({ where: { id }, data });
    await refreshPublicPublication(id, tx, { contentChanged });
  });
  invalidatePublicArticleCache();
  await recalculateArticleEvent(id);
  return getArticleDetail(id);
}

/** 详情（含最近 5 条 PushLog）；找不到时返回 null。 */
export async function getArticleDetail(id: string): Promise<ArticleDetailDto | null> {
  const article = await db.article.findUnique({
    where: { id },
    select: {
      ...ARTICLE_DETAIL_SELECT,
      source: { select: { name: true, type: true, url: true } },
    },
  });
  if (!article) return null;
  const pushLogs = article.eventId ? await db.pushLog.findMany({
    where: { eventId: article.eventId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      representativeArticleId: true,
      status: true,
      errorMessage: true,
      retryCount: true,
      webhookUrl: true,
      webhookRemark: true,
      createdAt: true,
    },
  }) : [];
  return serializeArticleDetail({
    ...article,
    pushLogs: pushLogs.map((log) => ({ ...log, articleId: log.representativeArticleId ?? article.id })),
  });
}

// ── 删除用例 ───────────────────────────────────────────────────

export interface ArticleDeleteResult {
  deleted: number;
  pushLogsDeleted: number;
}

/**
 * 由 ids 删除一组文章（带推送日志）。
 * 空 ids 直接返回零计数，不进入事务。
 */
export async function deleteArticlesByIds(ids: string[]): Promise<ArticleDeleteResult> {
  const cleaned = [...new Set(ids.filter(Boolean))];
  if (cleaned.length === 0) {
    return { deleted: 0, pushLogsDeleted: 0 };
  }
  const eventIds = (await db.article.findMany({ where: { id: { in: cleaned } }, select: { eventId: true } }))
    .flatMap((article) => article.eventId ? [article.eventId] : []);
  const result = await db.$transaction(async tx => {
    const articleResult = await tx.article.deleteMany({ where: { id: { in: cleaned } } });
    return { deleted: articleResult.count, pushLogsDeleted: 0 };
  });
  for (const eventId of new Set(eventIds)) {
    const reconciled = await reconcileEventAfterArticleDeletion(eventId);
    result.pushLogsDeleted += reconciled.pushLogsDeleted;
  }
  if (result.deleted > 0) invalidatePublicArticleCache();
  return result;
}

/**
 * 单篇删除：先删推送日志（外键约束），再删文章。
 */
export async function deleteArticleById(id: string): Promise<void> {
  const article = await db.article.findUnique({ where: { id }, select: { eventId: true } });
  await db.$transaction(async tx => {
    await tx.article.delete({ where: { id } });
  });
  if (article?.eventId) await reconcileEventAfterArticleDeletion(article.eventId);
  invalidatePublicArticleCache();
}

/**
 * 按筛选条件批量删除：先 findMany 取 ids，再走事务。
 * 与原 Route 保持一致：空 filter 仍走"全表删除"语义（findMany 无 where）。
 */
export async function deleteArticlesByFilter(
  filter: ArticleDeleteFilter,
): Promise<ArticleDeleteResult> {
  const where = buildArticleDeleteWhere(filter);
  const articles = await db.article.findMany({ where, select: { id: true } });
  const ids = articles.map((a) => a.id);
  if (ids.length === 0) {
    return { deleted: 0, pushLogsDeleted: 0 };
  }
  return deleteArticlesByIds(ids);
}
