import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import { parseJsonArray, splitBrands, stripHtml } from '@/lib/shared/article-codecs';
import { getPublicDateKey } from '@/lib/shared/public-date';
import type {
  PublicArticleDateGroupDto,
  PublicArticleDetailDto,
  PublicArticleListItemDto,
  PublicArticleListResponseDto,
  PublicArticleRelatedDto,
} from '@/contracts/public-articles';

const DEFAULT_PUBLIC_MIN_SCORE = 70;
const PUBLIC_MIN_SCORE_FLOOR = 0;
const PUBLIC_PAGE_SIZE = 20;
const PUBLIC_CACHE_TTL_MS = 60_000;
const PUBLIC_CACHE_MAX_ENTRIES = 100;

type PublicArticleListParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  sourceId?: string;
  from?: string;
  to?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: Promise<PublicArticleListResponseDto>;
};

type PublicConfig = { minScore: number; hideAds: boolean };

type PublicArticleSortRow = {
  id: string;
  publishedAt: Date | null;
  createdAt: Date;
  pinUntil: Date | null;
};

type PublicDateGroup = {
  date: string;
  ids: string[];
};

const listCache = new Map<string, CacheEntry>();

export function invalidatePublicArticleCache(): void {
  listCache.clear();
}

export async function getPublicMinScore(): Promise<number> {
  const row = await db.setting.findUnique({
    where: { key: SETTING_KEYS.PUBLIC_MIN_SCORE },
    select: { value: true },
  });
  const value = Number(row?.value ?? DEFAULT_PUBLIC_MIN_SCORE);
  if (!Number.isFinite(value)) return DEFAULT_PUBLIC_MIN_SCORE;
  return Math.min(100, Math.max(PUBLIC_MIN_SCORE_FLOOR, Math.round(value)));
}

async function getPublicConfig(): Promise<PublicConfig> {
  const [minScore, hideAds] = await Promise.all([
    getPublicMinScore(),
    db.setting.findUnique({ where: { key: SETTING_KEYS.PUBLIC_HIDE_ADS }, select: { value: true } }),
  ]);
  return { minScore, hideAds: hideAds?.value !== 'false' };
}

function normalizeText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function addEffectiveDateFilter(
  where: Prisma.ArticleWhereInput,
  from?: string,
  to?: string,
): void {
  const fromDate = parseDate(from);
  const toDate = parseDate(to, true);
  if (!fromDate && !toDate) return;

  const publishedAt: Prisma.DateTimeNullableFilter = {};
  const createdAt: Prisma.DateTimeFilter = {};
  if (fromDate) {
    publishedAt.gte = fromDate;
    createdAt.gte = fromDate;
  }
  if (toDate) {
    publishedAt.lte = toDate;
    createdAt.lte = toDate;
  }

  where.AND = [
    ...(Array.isArray(where.AND) ? where.AND : []),
    {
      OR: [
        { publishedAt },
        { publishedAt: null, createdAt },
      ],
    },
  ];
}

function buildPublicWhere(
  minScore: number,
  params: PublicArticleListParams = {},
  config: Pick<PublicConfig, 'hideAds'> = { hideAds: true },
): Prisma.ArticleWhereInput {
  const search = normalizeText(params.search, 100);
  const andClauses: Prisma.ArticleWhereInput[] = [
    { OR: [{ publicOverride: 'public' }, { publicOverride: 'auto', score: { gte: minScore } }] },
  ];
  // 人工“重要”覆盖是强制公开；隐藏软文只约束自动公开文章。
  if (config.hideAds) andClauses.push({ OR: [{ publicOverride: 'public' }, { isAd: false }] });
  if (search) andClauses.push({ OR: [
    { title: { contains: search } },
    { summary: { contains: search } },
    { brand: { contains: search } },
  ] });
  const where: Prisma.ArticleWhereInput = {
    aiStatus: 'done',
    source: { deletedAt: null, publicEnabled: true },
    AND: andClauses,
  };

  const sourceId = normalizeText(params.sourceId, 80);
  if (sourceId) where.sourceId = sourceId;
  addEffectiveDateFilter(where, params.from, params.to);
  return where;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toExcerpt(summary: string, cleanContent: string): string {
  if (summary) return summary;
  const text = stripHtml(cleanContent).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function serializeListItem(article: {
  id: string;
  url: string;
  title: string;
  originalSource: string | null;
  cleanContent: string;
  summary: string;
  brand: string;
  category: string;
  tags: string;
  score: number;
  publishedAt: Date | null;
  createdAt: Date;
  source: { id: string; name: string; type: string };
}): PublicArticleListItemDto {
  return {
    id: article.id,
    url: article.url,
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, article.cleanContent),
    summary: article.summary,
    brand: article.brand,
    category: article.category,
    tags: article.tags,
    score: article.score,
    publishedAt: toIso(article.publishedAt),
    createdAt: article.createdAt.toISOString(),
    source: article.source,
  };
}

function effectiveDate(article: PublicArticleSortRow): Date {
  return article.publishedAt ?? article.createdAt;
}

function comparePublicArticles(a: PublicArticleSortRow, b: PublicArticleSortRow, now: number): number {
  const dateCompare = getPublicDateKey(effectiveDate(b)).localeCompare(getPublicDateKey(effectiveDate(a)));
  if (dateCompare !== 0) return dateCompare;

  const aPinned = a.pinUntil instanceof Date && a.pinUntil.getTime() > now;
  const bPinned = b.pinUntil instanceof Date && b.pinUntil.getTime() > now;
  if (aPinned !== bPinned) return Number(bPinned) - Number(aPinned);

  const effectiveCompare = effectiveDate(b).getTime() - effectiveDate(a).getTime();
  if (effectiveCompare !== 0) return effectiveCompare;

  const createdCompare = b.createdAt.getTime() - a.createdAt.getTime();
  return createdCompare !== 0 ? createdCompare : a.id.localeCompare(b.id);
}

function buildPublicDateGroups(rows: PublicArticleSortRow[], now: number): PublicDateGroup[] {
  const sorted = [...rows].sort((a, b) => comparePublicArticles(a, b, now));
  const groups = new Map<string, PublicDateGroup>();
  for (const row of sorted) {
    const date = getPublicDateKey(effectiveDate(row));
    const group = groups.get(date) ?? { date, ids: [] };
    group.ids.push(row.id);
    groups.set(date, group);
  }
  return [...groups.values()];
}

function paginatePublicDateGroups(groups: PublicDateGroup[], targetSize: number): PublicDateGroup[][] {
  const pages: PublicDateGroup[][] = [];
  let currentPage: PublicDateGroup[] = [];
  let currentSize = 0;

  for (const group of groups) {
    if (currentPage.length > 0 && currentSize + group.ids.length > targetSize) {
      pages.push(currentPage);
      currentPage = [];
      currentSize = 0;
    }
    currentPage.push(group);
    currentSize += group.ids.length;
  }

  if (currentPage.length > 0) pages.push(currentPage);
  return pages;
}

async function loadPublicArticleList(
  params: PublicArticleListParams,
): Promise<PublicArticleListResponseDto> {
  const config = await getPublicConfig();
  const minScore = config.minScore;
  const page = Math.min(10_000, Math.max(1, Math.floor(params.page ?? 1)));
  const pageSize = Math.min(50, Math.max(1, Math.floor(params.pageSize ?? PUBLIC_PAGE_SIZE)));
  await db.article.updateMany({ where: { pinUntil: { lt: new Date() } }, data: { pinUntil: null } });
  const where = buildPublicWhere(minScore, params, config);
  const facetWhere = buildPublicWhere(minScore, {}, config);

  const [candidateRows, sourceRows] = await Promise.all([
    db.article.findMany({
      where,
      select: { id: true, publishedAt: true, createdAt: true, pinUntil: true },
    }),
    db.article.groupBy({
      by: ['sourceId'],
      where: facetWhere,
      _count: { _all: true },
    }),
  ]);

  const now = Date.now();
  const dateGroups = buildPublicDateGroups(candidateRows, now);
  const pages = paginatePublicDateGroups(dateGroups, pageSize);
  const resolvedPage = pages.length === 0 ? 1 : Math.min(page, pages.length);
  const selectedGroups = pages[resolvedPage - 1] ?? [];
  const pageIds = selectedGroups.flatMap((group) => group.ids);

  const items = pageIds.length === 0 ? [] : await db.article.findMany({
      where: { ...where, id: { in: pageIds } },
      select: {
        id: true,
        url: true,
        title: true,
        originalSource: true,
        cleanContent: true,
        summary: true,
        brand: true,
        category: true,
        tags: true,
        score: true,
        publishedAt: true,
        createdAt: true,
        source: { select: { id: true, name: true, type: true } },
      },
    });

  const itemMap = new Map(items.map((item) => [item.id, serializeListItem(item)]));
  const groups: PublicArticleDateGroupDto[] = selectedGroups.map((group) => ({
    date: group.date,
    count: group.ids.length,
    items: group.ids.flatMap((id) => {
      const item = itemMap.get(id);
      return item ? [item] : [];
    }),
  }));
  const serializedItems = groups.flatMap((group) => group.items);

  const sources = await db.source.findMany({
    where: { id: { in: sourceRows.map((row) => row.sourceId) }, deletedAt: null },
    select: { id: true, name: true },
  });
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));

  return {
    items: serializedItems,
    groups,
    pageStartDate: groups[0]?.date ?? null,
    pageEndDate: groups.at(-1)?.date ?? null,
    total: candidateRows.length,
    page: resolvedPage,
    pageSize,
    totalPages: pages.length,
    sources: sourceRows
      .map((row) => ({
        id: row.sourceId,
        name: sourceNames.get(row.sourceId) ?? row.sourceId,
        count: row._count._all,
      }))
      .filter((source) => source.name !== source.id)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')),
    minScore,
  };
}

export async function listPublicArticles(
  params: PublicArticleListParams = {},
): Promise<PublicArticleListResponseDto> {
  const key = JSON.stringify({
    page: params.page ?? 1,
    pageSize: params.pageSize ?? PUBLIC_PAGE_SIZE,
    search: normalizeText(params.search, 100) ?? '',
    sourceId: normalizeText(params.sourceId, 80) ?? '',
    from: params.from ?? '',
    to: params.to ?? '',
  });
  const existing = listCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  const value = loadPublicArticleList(params);
  listCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  while (listCache.size > PUBLIC_CACHE_MAX_ENTRIES) {
    const firstKey = listCache.keys().next().value;
    if (!firstKey) break;
    listCache.delete(firstKey);
  }
  void value.catch(() => listCache.delete(key));
  return value;
}

export async function getPublicArticleDetail(id: string, options: { recordView?: boolean } = {}): Promise<PublicArticleDetailDto | null> {
  const config = await getPublicConfig();
  const minScore = config.minScore;
  await db.article.updateMany({ where: { pinUntil: { lt: new Date() } }, data: { pinUntil: null } });
  const article = await db.article.findFirst({
    where: { id, ...buildPublicWhere(minScore, {}, config) },
    select: {
      id: true,
      url: true,
      title: true,
      originalSource: true,
      cleanContent: true,
      summary: true,
      brand: true,
      category: true,
      tags: true,
      score: true,
      keyPoints: true,
      publishedAt: true,
      createdAt: true,
      source: { select: { id: true, name: true, type: true } },
    },
  });
  if (!article) return null;
  if (options.recordView) await db.article.update({ where: { id }, data: { viewCount: { increment: 1 } } });

  const base = serializeListItem(article);
  const brands = splitBrands(article.brand).filter(Boolean).slice(0, 8);
  const related = brands.length > 0
    ? await db.article.findMany({
        where: {
          ...buildPublicWhere(minScore, {}, config),
          id: { not: id },
          OR: brands.flatMap((brand) => [
            { brand: { contains: brand } },
            { title: { contains: brand } },
            { summary: { contains: brand } },
          ]),
        },
        select: {
          id: true,
          title: true,
          score: true,
          publishedAt: true,
          createdAt: true,
          source: { select: { name: true, type: true } },
        },
        orderBy: [{ pinUntil: 'desc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 5,
      })
    : [];

  const relatedDto: PublicArticleRelatedDto[] = related.map((item) => ({
    id: item.id,
    title: item.title,
    score: item.score,
    publishedAt: toIso(item.publishedAt),
    createdAt: item.createdAt.toISOString(),
    source: item.source,
  }));

  return {
    ...base,
    keyPoints: parseJsonArray(article.keyPoints),
    contentPreview: stripHtml(article.cleanContent).replace(/\s+/g, ' ').trim().slice(0, 2000),
    related: relatedDto,
  };
}

export async function listPublicArticleIds(): Promise<Array<{ id: string; updatedAt: Date }>> {
  const config = await getPublicConfig();
  const minScore = config.minScore;
  return db.article.findMany({
    where: buildPublicWhere(minScore, {}, config),
    select: { id: true, updatedAt: true },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function recordOriginalClick(id: string): Promise<boolean> {
  const config = await getPublicConfig();
  const article = await db.article.findFirst({ where: { id, ...buildPublicWhere(config.minScore, {}, config) }, select: { id: true } });
  if (!article) return false;
  await db.article.update({ where: { id }, data: { originalClickCount: { increment: 1 } } });
  return true;
}
