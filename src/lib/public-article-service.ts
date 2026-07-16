import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseJsonArray, splitBrands, stripHtml } from '@/lib/shared/article-codecs';
import { getPublicDateKey } from '@/lib/shared/public-date';
import { enqueuePublicArticleView } from '@/lib/public-view-service';
import { publicArticleListCache } from '@/lib/public-article-cache';
import type {
  PublicArticleDateGroupDto,
  PublicArticleDetailDto,
  PublicArticleFeedRevisionDto,
  PublicArticleListItemDto,
  PublicArticleListResponseDto,
  PublicArticleNavigationItemDto,
  PublicArticleRelatedDto,
} from '@/contracts/public-articles';

const PUBLIC_INITIAL_DATE_LIMIT = 3;
const PUBLIC_SEARCH_DATE_LIMIT = 10;
const PUBLIC_LOAD_MORE_DATE_LIMIT = 3;
const PUBLIC_CACHE_TTL_MS = 60_000;
const PUBLIC_CACHE_MAX_ENTRIES = 100;

type PublicArticleListParams = {
  search?: string;
  sourceId?: string;
  from?: string;
  to?: string;
  before?: string;
  dateLimit?: number;
};

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

type PublicDateGroupRow = {
  date: string;
  count: number | bigint;
};

function normalizeText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
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

function getDateLimit(params: PublicArticleListParams, hasSearch: boolean): number {
  const fallback = params.before
    ? PUBLIC_LOAD_MORE_DATE_LIMIT
    : hasSearch ? PUBLIC_SEARCH_DATE_LIMIT : PUBLIC_INITIAL_DATE_LIMIT;
  const value = Number.isFinite(params.dateLimit) ? Math.floor(params.dateLimit!) : fallback;
  return Math.min(PUBLIC_SEARCH_DATE_LIMIT, Math.max(1, value));
}

function buildPublicWhere(params: PublicArticleListParams = {}): Prisma.ArticleWhereInput {
  const search = normalizeText(params.search, 100);
  const andClauses: Prisma.ArticleWhereInput[] = [];
  if (search) andClauses.push({ OR: [
    { title: { contains: search } },
    { summary: { contains: search } },
    { brand: { contains: search } },
  ] });
  const where: Prisma.ArticleWhereInput = {
    publicStatus: 'published',
    AND: andClauses,
  };

  const sourceId = normalizeText(params.sourceId, 80);
  if (sourceId) where.sourceId = sourceId;
  addEffectiveDateFilter(where, params.from, params.to);
  return where;
}

function buildPublicSqlWhere(params: PublicArticleListParams = {}): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`"publicStatus" = 'published'`];
  const search = normalizeText(params.search, 100);
  const effectiveDate = Prisma.sql`COALESCE("publishedAt", "createdAt")`;

  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    clauses.push(Prisma.sql`(
      "title" LIKE ${pattern} ESCAPE '\\'
      OR "summary" LIKE ${pattern} ESCAPE '\\'
      OR "brand" LIKE ${pattern} ESCAPE '\\'
    )`);
  }

  const sourceId = normalizeText(params.sourceId, 80);
  if (sourceId) clauses.push(Prisma.sql`"sourceId" = ${sourceId}`);

  const fromDate = parseDate(params.from);
  const toDate = parseDate(params.to, true);
  const beforeDate = parseDate(params.before);
  if (fromDate) clauses.push(Prisma.sql`${effectiveDate} >= ${fromDate.getTime()}`);
  if (toDate) clauses.push(Prisma.sql`${effectiveDate} <= ${toDate.getTime()}`);
  if (beforeDate) clauses.push(Prisma.sql`${effectiveDate} < ${beforeDate.getTime()}`);

  return Prisma.join(clauses, ' AND ');
}

async function loadPublicDateGroups(
  params: PublicArticleListParams,
  dateLimit: number,
): Promise<PublicDateGroupRow[]> {
  const dateKey = Prisma.sql`strftime('%Y-%m-%d', datetime(COALESCE("publishedAt", "createdAt") / 1000, 'unixepoch', '+8 hours'))`;
  return db.$queryRaw<PublicDateGroupRow[]>(Prisma.sql`
    SELECT ${dateKey} AS date, COUNT(*) AS count
    FROM "articles"
    WHERE ${buildPublicSqlWhere(params)}
    GROUP BY ${dateKey}
    ORDER BY date DESC
    LIMIT ${dateLimit + 1}
  `);
}

async function countPublicArticles(params: PublicArticleListParams = {}): Promise<number> {
  const rows = await db.$queryRaw<Array<{ count: number | bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "articles"
    WHERE ${buildPublicSqlWhere(params)}
  `);
  return Number(rows[0]?.count ?? 0);
}

async function loadPublicArticleIds(
  params: PublicArticleListParams,
  dates: string[],
): Promise<string[]> {
  if (dates.length === 0) return [];
  const dateKey = Prisma.sql`strftime('%Y-%m-%d', datetime(COALESCE("publishedAt", "createdAt") / 1000, 'unixepoch', '+8 hours'))`;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "articles"
    WHERE ${buildPublicSqlWhere(params)}
      AND ${dateKey} IN (${Prisma.join(dates)})
  `);
  return rows.map((row) => row.id);
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

async function loadPublicArticleList(
  params: PublicArticleListParams,
): Promise<PublicArticleListResponseDto> {
  const search = normalizeText(params.search, 100);
  const dateLimit = getDateLimit(params, Boolean(search));
  const totalParams = { ...params, before: undefined };

  const [dateRows, total] = await Promise.all([
    loadPublicDateGroups(params, dateLimit),
    countPublicArticles(totalParams),
  ]);

  const selectedDateRows = dateRows.slice(0, dateLimit);
  const selectedDates = selectedDateRows.map((row) => row.date);
  const pageIds = await loadPublicArticleIds(params, selectedDates);

  const items = pageIds.length === 0 ? [] : await db.article.findMany({
      where: { id: { in: pageIds } },
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
        pinUntil: true,
        source: { select: { id: true, name: true, type: true } },
      },
    });

  const itemMap = new Map(items.map((item) => [item.id, serializeListItem(item)]));
  const itemGroups = buildPublicDateGroups(items, Date.now());
  const groups: PublicArticleDateGroupDto[] = selectedDateRows.map((row) => {
    const itemGroup = itemGroups.find((group) => group.date === row.date);
    return {
      date: row.date,
      count: Number(row.count),
      items: itemGroup?.ids.flatMap((id) => {
      const item = itemMap.get(id);
      return item ? [item] : [];
      }) ?? [],
    };
  });
  const serializedItems = groups.flatMap((group) => group.items);

  return {
    items: serializedItems,
    groups,
    total,
    displayedArticleCount: serializedItems.length,
    displayedDateCount: groups.length,
    nextDate: selectedDateRows.at(-1)?.date ?? null,
    hasMore: dateRows.length > selectedDateRows.length,
  };
}

async function loadPublicArticleNavigation(articleId: string): Promise<{
  previous: PublicArticleNavigationItemDto | null;
  next: PublicArticleNavigationItemDto | null;
}> {
  const effectiveDateKey = Prisma.sql`strftime('%Y-%m-%d', datetime(COALESCE("publishedAt", "createdAt") / 1000, 'unixepoch', '+8 hours'))`;
  const effectiveDate = Prisma.sql`COALESCE("publishedAt", "createdAt")`;
  const pinOrder = Prisma.sql`CASE WHEN "pinUntil" IS NOT NULL AND "pinUntil" > ${Date.now()} THEN 0 ELSE 1 END`;
  const rows = await db.$queryRaw<Array<{
    previousId: string | null;
    previousTitle: string | null;
    nextId: string | null;
    nextTitle: string | null;
  }>>(Prisma.sql`
    SELECT "previousId", "previousTitle", "nextId", "nextTitle"
    FROM (
      SELECT
        "id",
        LAG("id") OVER (
          ORDER BY ${effectiveDateKey} DESC, ${pinOrder}, ${effectiveDate} DESC, "createdAt" DESC, "id" ASC
        ) AS "previousId",
        LAG("title") OVER (
          ORDER BY ${effectiveDateKey} DESC, ${pinOrder}, ${effectiveDate} DESC, "createdAt" DESC, "id" ASC
        ) AS "previousTitle",
        LEAD("id") OVER (
          ORDER BY ${effectiveDateKey} DESC, ${pinOrder}, ${effectiveDate} DESC, "createdAt" DESC, "id" ASC
        ) AS "nextId",
        LEAD("title") OVER (
          ORDER BY ${effectiveDateKey} DESC, ${pinOrder}, ${effectiveDate} DESC, "createdAt" DESC, "id" ASC
        ) AS "nextTitle"
      FROM "articles"
      WHERE "publicStatus" = 'published'
    ) ordered
    WHERE "id" = ${articleId}
  `);
  const row = rows[0];
  return {
    previous: row?.previousId && row.previousTitle
      ? { id: row.previousId, title: row.previousTitle }
      : null,
    next: row?.nextId && row.nextTitle
      ? { id: row.nextId, title: row.nextTitle }
      : null,
  };
}

export async function getPublicArticleFeedRevision(
  params: Pick<PublicArticleListParams, 'search' | 'sourceId' | 'from' | 'to'> = {},
): Promise<PublicArticleFeedRevisionDto> {
  return {
    total: await countPublicArticles(params),
  };
}

export async function listPublicArticles(
  params: PublicArticleListParams = {},
): Promise<PublicArticleListResponseDto> {
  const key = JSON.stringify({
    search: normalizeText(params.search, 100) ?? '',
    sourceId: normalizeText(params.sourceId, 80) ?? '',
    from: params.from ?? '',
    to: params.to ?? '',
    before: params.before ?? '',
    dateLimit: params.dateLimit ?? '',
  });
  const existing = publicArticleListCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  const value = loadPublicArticleList(params);
  publicArticleListCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  while (publicArticleListCache.size > PUBLIC_CACHE_MAX_ENTRIES) {
    const firstKey = publicArticleListCache.keys().next().value;
    if (!firstKey) break;
    publicArticleListCache.delete(firstKey);
  }
  void value.catch(() => publicArticleListCache.delete(key));
  return value;
}

export async function listPublicSourceOptions(): Promise<Array<{ id: string; name: string }>> {
  const sources = await db.source.findMany({
    where: {
      deletedAt: null,
      publicEnabled: true,
      articles: { some: { publicStatus: 'published' } },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return sources;
}

export async function getPublicArticleDetail(id: string, options: { recordView?: boolean } = {}): Promise<PublicArticleDetailDto | null> {
  const article = await db.article.findFirst({
    where: { id, ...buildPublicWhere() },
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
  if (options.recordView) enqueuePublicArticleView(id);

  const base = serializeListItem(article);
  const navigation = await loadPublicArticleNavigation(id);
  const brands = splitBrands(article.brand).filter(Boolean).slice(0, 8);
  const relatedLikeClauses = brands.flatMap((brand) => {
    const pattern = `%${escapeLikePattern(brand)}%`;
    return [
      Prisma.sql`"brand" LIKE ${pattern} ESCAPE '\\'`,
      Prisma.sql`"title" LIKE ${pattern} ESCAPE '\\'`,
      Prisma.sql`"summary" LIKE ${pattern} ESCAPE '\\'`,
    ];
  });
  const relatedIdRows = relatedLikeClauses.length === 0
    ? []
    : await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "articles"
        WHERE "publicStatus" = 'published'
          AND "id" <> ${id}
          AND (${Prisma.join(relatedLikeClauses, ' OR ')})
        ORDER BY
          CASE WHEN "pinUntil" IS NOT NULL AND "pinUntil" > ${Date.now()} THEN 0 ELSE 1 END,
          "pinUntil" DESC,
          COALESCE("publishedAt", "createdAt") DESC,
          "createdAt" DESC,
          "id" ASC
        LIMIT 5
      `);
  const relatedIds = relatedIdRows.map((row) => row.id);
  const relatedRows = relatedIds.length === 0
    ? []
    : await db.article.findMany({
        where: { id: { in: relatedIds } },
        select: {
          id: true,
          title: true,
          score: true,
          publishedAt: true,
          createdAt: true,
          source: { select: { name: true, type: true } },
        },
      });
  const relatedById = new Map(relatedRows.map((item) => [item.id, item]));
  const related = relatedIds.flatMap((relatedId) => {
    const item = relatedById.get(relatedId);
    return item ? [item] : [];
  });

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
    related: relatedDto,
    navigation,
  };
}

export async function listPublicArticleIds(): Promise<Array<{ id: string; updatedAt: Date }>> {
  const articles = await db.article.findMany({
    where: buildPublicWhere(),
    select: {
      id: true,
      publicContentUpdatedAt: true,
    },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
  });
  return articles.map((article) => {
    if (!article.publicContentUpdatedAt) {
      throw new Error(`公开文章缺少内容更新时间: ${article.id}`);
    }
    return { id: article.id, updatedAt: article.publicContentUpdatedAt };
  });
}

export async function recordOriginalClick(id: string): Promise<boolean> {
  const article = await db.article.findFirst({ where: { id, ...buildPublicWhere() }, select: { id: true } });
  if (!article) return false;
  // 点击统计同样不应修改内容更新时间。
  await db.$executeRaw`
    UPDATE "articles"
    SET "originalClickCount" = "originalClickCount" + 1
    WHERE "id" = ${id}
  `;
  return true;
}
