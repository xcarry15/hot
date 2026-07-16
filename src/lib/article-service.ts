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
import { db } from '@/lib/db';
import {
  ARTICLE_DETAIL_SELECT,
  ARTICLE_LIST_SELECT,
  serializeArticleDetail,
  serializeArticleListItem,
  type ArticleDetailDto,
  type ArticleListResponseDto,
} from '@/contracts/articles';
import { splitBrands } from '@/lib/shared/article-codecs';
import { parseDedupEvidence } from '@/lib/dedup-evidence';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';

type ArticleMutationDb = Pick<typeof db, 'article' | 'pushLog' | '$transaction'>;

async function clearDuplicateWinnerReferences(
  client: Pick<ArticleMutationDb, 'article'>,
  deletedIds: string[],
): Promise<void> {
  const affected = await client.article.findMany({
    where: { duplicateOfId: { in: deletedIds }, id: { notIn: deletedIds } },
    select: { id: true, dedupDetail: true },
  });
  for (const article of affected) {
    const evidence = parseDedupEvidence(article.dedupDetail);
    await client.article.update({
      where: { id: article.id },
      data: {
        duplicateOfId: null,
        dedupDetail: evidence
          ? JSON.stringify({ ...evidence, matchedId: undefined })
          : article.dedupDetail,
      },
    });
  }
}

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
  sourceId?: string;
  search?: string;
  reviewStatus?: string;
  fetchStatus?: string;
  inbox?: boolean;
}

export function buildArticleListWhere(filter: ArticleListFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filter.aiStatus) where.aiStatus = filter.aiStatus;
  if (filter.brandContains) where.brand = { contains: filter.brandContains };
  if (filter.category) where.category = filter.category;
  if (Number.isFinite(filter.minScore)) where.score = { gte: filter.minScore };
  if (Number.isFinite(filter.minRelevance)) where.relevance = { gte: filter.minRelevance };
  if (filter.sourceId) where.sourceId = filter.sourceId;
  if (filter.reviewStatus) where.reviewStatus = filter.reviewStatus;
  if (filter.fetchStatus) where.fetchStatus = filter.fetchStatus;
  if (filter.inbox) {
    where.fetchStatus = 'fetched';
    where.reviewStatus = 'unreviewed';
  }
  if (filter.search) {
    where.OR = [
      { title: { contains: filter.search } },
      { summary: { contains: filter.search } },
      { brand: { contains: filter.search } },
    ];
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

export function buildArticleDeleteWhere(filter: ArticleDeleteFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
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

  const [items, total, categoryRows, brandRows] = await Promise.all([
    db.article.findMany({
      where,
      select: {
        ...ARTICLE_LIST_SELECT,
        source: { select: { name: true, type: true } },
      },
      orderBy: params.filter?.inbox
        ? [{ createdAt: 'asc' }]
        : [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.article.count({ where }),
    db.article.groupBy({
      by: ['category'],
      where: { category: { not: '' } },
      _count: { category: true },
    }),
    db.article.findMany({
      where: { brand: { not: '' } },
      select: { brand: true },
    }),
  ]);

  const brandCounts = new Map<string, number>();
  for (const row of brandRows) {
    for (const brand of new Set(splitBrands(row.brand))) {
      brandCounts.set(brand, (brandCounts.get(brand) ?? 0) + 1);
    }
  }

  return {
    items: items.map(serializeArticleListItem),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    facets: {
      categories: categoryRows
        .map((row) => ({ value: row.category, count: row._count.category }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN')),
      brands: Array.from(brandCounts, ([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN')),
    },
  };
}

/** 详情（含最近 5 条 PushLog）；找不到时返回 null。 */
export async function getArticleDetail(id: string): Promise<ArticleDetailDto | null> {
  const article = await db.article.findUnique({
    where: { id },
    select: {
      ...ARTICLE_DETAIL_SELECT,
      source: { select: { name: true, type: true, url: true } },
      pushLogs: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          articleId: true,
          status: true,
          errorMessage: true,
          retryCount: true,
          webhookUrl: true,
          webhookRemark: true,
          createdAt: true,
        },
      },
    },
  });
  if (!article) return null;
  return serializeArticleDetail(article);
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
  const result = await db.$transaction(async tx => {
    const pushResult = await tx.pushLog.deleteMany({ where: { articleId: { in: cleaned } } });
    // duplicateOfId 是逻辑关联而非外键。赢家被删除前先解除引用，
    // 否则后台会长期展示一个不存在的“关联原文”。
    await clearDuplicateWinnerReferences(tx, cleaned);
    const articleResult = await tx.article.deleteMany({ where: { id: { in: cleaned } } });
    return { deleted: articleResult.count, pushLogsDeleted: pushResult.count };
  });
  if (result.deleted > 0) invalidatePublicArticleCache();
  return result;
}

/**
 * 单篇删除：先删推送日志（外键约束），再删文章。
 */
export async function deleteArticleById(id: string): Promise<void> {
  await db.$transaction(async tx => {
    await tx.pushLog.deleteMany({ where: { articleId: id } });
    await clearDuplicateWinnerReferences(tx, [id]);
    await tx.article.delete({ where: { id } });
  });
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
