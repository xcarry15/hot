import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { parseJsonArray, splitBrands, stripHtml } from '@/lib/shared/article-codecs';
import { getPublicDateKey } from '@/lib/shared/public-date';
import { enqueuePublicArticleOriginalClick, enqueuePublicArticleView } from '@/lib/public-view-service';
import { publicArticleListCache } from '@/lib/public-article-cache';
import type {
  PublicArticleDateGroupDto,
  PublicArticleDetailDto,
  PublicArticleFeedRevisionDto,
  PublicArticleListItemDto,
  PublicArticleListResponseDto,
  PublicArticleRelatedDto,
} from '@/contracts/public-articles';

const PUBLIC_INITIAL_DATE_LIMIT = 3;
const PUBLIC_SEARCH_DATE_LIMIT = 10;
const PUBLIC_LOAD_MORE_DATE_LIMIT = 3;
const PUBLIC_CACHE_TTL_MS = 60_000;
const PUBLIC_MAX_ROWS_PER_DATE = 250;

type PublicArticleListParams = { search?: string; before?: string; dateLimit?: number };

const representativeListSelect = {
  id: true,
  url: true,
  title: true,
  originalSource: true,
  summary: true,
  brand: true,
  category: true,
  tags: true,
  score: true,
  pinUntil: true,
  publishedAt: true,
  createdAt: true,
  source: { select: { id: true, name: true, type: true } },
} as const;

const representativeDetailSelect = {
  ...representativeListSelect,
  cleanContent: true,
  keyPoints: true,
  publicContentUpdatedAt: true,
} as const;

type PublicEventListRow = Prisma.EventGetPayload<{
  select: {
    id: true;
    firstSeenAt: true;
    lastSeenAt: true;
    articleCount: true;
    representativeArticle: { select: typeof representativeListSelect };
  };
}>;

const publicEventWhere = {
  status: 'active',
  publicStatus: 'published',
  representativeArticleId: { not: null },
  representativeArticle: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
} as const;

function normalizeText(value: string | undefined, maxLength: number): string {
  return value?.trim().slice(0, maxLength) ?? '';
}

function toExcerpt(summary: string, cleanContent = ''): string {
  if (summary) return summary;
  const text = stripHtml(cleanContent).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

type SortablePublicEventRow = {
  firstSeenAt: Date;
  representativeArticle: {
    publishedAt: Date | null;
    pinUntil: Date | null;
  } | null;
};

function effectiveDate(row: SortablePublicEventRow): Date {
  return row.representativeArticle!.publishedAt ?? row.firstSeenAt;
}

function serializeEvent(row: PublicEventListRow, cleanContent = ''): PublicArticleListItemDto {
  const article = row.representativeArticle!;
  return {
    id: row.id,
    url: article.url,
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, cleanContent),
    summary: article.summary,
    brand: article.brand,
    category: article.category,
    tags: article.tags,
    score: article.score,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: row.firstSeenAt.toISOString(),
    sourceCount: row.articleCount,
    source: article.source,
  };
}

function matchesSearch(row: PublicEventListRow, search: string): boolean {
  if (!search) return true;
  const article = row.representativeArticle!;
  return `${article.title}\n${article.summary}\n${article.brand}`.toLowerCase().includes(search.toLowerCase());
}

function sortEvents(left: SortablePublicEventRow, right: SortablePublicEventRow): number {
  const dateKey = getPublicDateKey(effectiveDate(right)).localeCompare(getPublicDateKey(effectiveDate(left)));
  if (dateKey !== 0) return dateKey;
  const now = Date.now();
  const leftPinned = (left.representativeArticle?.pinUntil?.getTime() ?? 0) > now;
  const rightPinned = (right.representativeArticle?.pinUntil?.getTime() ?? 0) > now;
  if (leftPinned !== rightPinned) return Number(rightPinned) - Number(leftPinned);
  return effectiveDate(right).getTime() - effectiveDate(left).getTime();
}

function dateLimit(params: PublicArticleListParams, hasSearch: boolean): number {
  const fallback = params.before ? PUBLIC_LOAD_MORE_DATE_LIMIT : hasSearch ? PUBLIC_SEARCH_DATE_LIMIT : PUBLIC_INITIAL_DATE_LIMIT;
  return Math.max(1, Math.min(PUBLIC_SEARCH_DATE_LIMIT, Math.floor(params.dateLimit ?? fallback)));
}

async function buildList(params: PublicArticleListParams): Promise<PublicArticleListResponseDto> {
  const search = normalizeText(params.search, 100);
  const before = params.before && /^\d{4}-\d{2}-\d{2}$/.test(params.before) ? params.before : '';
  const limit = dateLimit(params, Boolean(search));
  const searchWhere = search ? {
    representativeArticle: {
      is: {
        aiStatus: 'done',
        clusterStatus: 'clustered',
        OR: [
          { title: { contains: search } },
          { summary: { contains: search } },
          { brand: { contains: search } },
        ],
      },
    },
  } : {};
  const feedWhere = {
    ...publicEventWhere,
    ...(before ? { publicDateKey: { lt: before } } : {}),
    ...searchWhere,
  };
  const dateRows = await db.event.groupBy({
    by: ['publicDateKey'],
    where: feedWhere,
    orderBy: { publicDateKey: 'desc' },
    take: limit + 1,
  });
  const selectedDates = dateRows.slice(0, limit).map((row) => row.publicDateKey).filter(Boolean);
  const rows = (await Promise.all(selectedDates.map((date) => db.event.findMany({
    where: { ...feedWhere, publicDateKey: date },
    select: {
      id: true,
      firstSeenAt: true,
      lastSeenAt: true,
      articleCount: true,
      representativeArticle: { select: representativeListSelect },
    },
    orderBy: [{ publicSortAt: 'desc' }, { id: 'desc' }],
    take: PUBLIC_MAX_ROWS_PER_DATE,
  })))).flat();
  const all = rows.filter((row) => matchesSearch(row, search)).sort(sortEvents);
  const eligible = all;
  const grouped = new Map<string, PublicEventListRow[]>();
  for (const row of eligible) {
    const key = getPublicDateKey(effectiveDate(row));
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  const groups: PublicArticleDateGroupDto[] = selectedDates.map((date) => {
    const rows = grouped.get(date) ?? [];
    return { date, count: rows.length, items: rows.map(serializeEvent) };
  });
  const items = groups.flatMap((group) => group.items);
  const total = await db.event.count({
    where: search ? {
      ...publicEventWhere,
      representativeArticle: {
        is: {
          aiStatus: 'done',
          clusterStatus: 'clustered',
          OR: [
            { title: { contains: search } },
            { summary: { contains: search } },
            { brand: { contains: search } },
          ],
        },
      },
    } : publicEventWhere,
  });
  return {
    total,
    items,
    groups,
    displayedArticleCount: items.length,
    displayedDateCount: groups.length,
    nextDate: selectedDates.at(-1) ?? null,
    hasMore: dateRows.length > selectedDates.length,
  };
}

export async function getPublicArticleFeedRevision(params: Pick<PublicArticleListParams, 'search'> = {}): Promise<PublicArticleFeedRevisionDto> {
  const search = normalizeText(params.search, 100);
  if (!search) return { total: await db.event.count({ where: publicEventWhere }) };
  return {
    total: await db.event.count({
      where: {
        ...publicEventWhere,
        representativeArticle: {
          is: {
            aiStatus: 'done',
            clusterStatus: 'clustered',
            OR: [
              { title: { contains: search } },
              { summary: { contains: search } },
              { brand: { contains: search } },
            ],
          },
        },
      },
    }),
  };
}

export async function listPublicArticles(params: PublicArticleListParams = {}): Promise<PublicArticleListResponseDto> {
  const key = JSON.stringify({ search: normalizeText(params.search, 100), before: params.before ?? '', dateLimit: params.dateLimit ?? '' });
  const existing = publicArticleListCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const value = buildList(params);
  publicArticleListCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  void value.catch(() => publicArticleListCache.delete(key));
  return value;
}

export async function getPublicArticleDetail(id: string): Promise<PublicArticleDetailDto | null> {
  const [row] = await db.event.findMany({
    where: { ...publicEventWhere, id },
    select: {
      id: true,
      firstSeenAt: true,
      lastSeenAt: true,
      articleCount: true,
      publicDateKey: true,
      representativeArticle: { select: representativeDetailSelect },
    },
    take: 1,
  });
  if (!row?.representativeArticle) return null;
  const article = row.representativeArticle!;
  const brands = splitBrands(article.brand).filter(Boolean);
  const [sameDateRows, relatedRows, sources] = await Promise.all([
    db.event.findMany({
      where: { ...publicEventWhere, publicDateKey: row.publicDateKey },
      select: {
        id: true,
        firstSeenAt: true,
        representativeArticle: { select: { title: true, publishedAt: true, pinUntil: true } },
      },
      orderBy: [{ publicSortAt: 'desc' }, { id: 'desc' }],
      take: PUBLIC_MAX_ROWS_PER_DATE,
    }),
    brands.length === 0
      ? Promise.resolve([])
      : db.event.findMany({
          where: {
            ...publicEventWhere,
            id: { not: row.id },
            representativeArticle: {
              is: {
                aiStatus: 'done',
                clusterStatus: 'clustered',
                OR: brands.map((brand) => ({ brand: { contains: brand } })),
              },
            },
          },
          select: {
            id: true,
            firstSeenAt: true,
            articleCount: true,
            representativeArticle: {
              select: {
                title: true,
                score: true,
                publishedAt: true,
                source: { select: { name: true, type: true } },
              },
            },
          },
          orderBy: { firstSeenAt: 'desc' },
          take: 5,
        }),
    db.article.findMany({
      where: { eventId: row.id },
      select: { id: true, title: true, url: true, publishedAt: true, createdAt: true, source: { select: { name: true, type: true } } },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    }),
  ]);
  const sortedNavigation = sameDateRows
    .filter((candidate) => candidate.representativeArticle)
    .sort(sortEvents);
  const index = sortedNavigation.findIndex((candidate) => candidate.id === id);
  const [newerBoundary, olderBoundary] = await Promise.all([
    index === 0
      ? db.event.findFirst({
          where: { ...publicEventWhere, publicDateKey: { gt: row.publicDateKey } },
          orderBy: [{ publicDateKey: 'asc' }, { publicSortAt: 'asc' }, { id: 'asc' }],
          select: { id: true, representativeArticle: { select: { title: true } } },
        })
      : Promise.resolve(null),
    index === sortedNavigation.length - 1
      ? db.event.findFirst({
          where: { ...publicEventWhere, publicDateKey: { lt: row.publicDateKey } },
          orderBy: [{ publicDateKey: 'desc' }, { publicSortAt: 'desc' }, { id: 'desc' }],
          select: { id: true, representativeArticle: { select: { title: true } } },
        })
      : Promise.resolve(null),
  ]);
  const related: PublicArticleRelatedDto[] = relatedRows.map((candidate) => ({
    id: candidate.id,
    title: candidate.representativeArticle!.title,
    score: candidate.representativeArticle!.score,
    publishedAt: candidate.representativeArticle!.publishedAt?.toISOString() ?? null,
    createdAt: candidate.firstSeenAt.toISOString(),
    source: candidate.representativeArticle!.source,
  }));
  return {
    ...serializeEvent(row, article.cleanContent),
    keyPoints: parseJsonArray(article.keyPoints),
    related,
    sources: sources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      publishedAt: source.publishedAt?.toISOString() ?? null,
      createdAt: source.createdAt.toISOString(),
      source: source.source,
    })),
    navigation: {
      previous: index > 0
        ? { id: sortedNavigation[index - 1].id, title: sortedNavigation[index - 1].representativeArticle!.title }
        : newerBoundary?.representativeArticle
          ? { id: newerBoundary.id, title: newerBoundary.representativeArticle.title }
          : null,
      next: index >= 0 && index + 1 < sortedNavigation.length
        ? { id: sortedNavigation[index + 1].id, title: sortedNavigation[index + 1].representativeArticle!.title }
        : olderBoundary?.representativeArticle
          ? { id: olderBoundary.id, title: olderBoundary.representativeArticle.title }
          : null,
    },
  };
}

export async function recordPublicArticleView(id: string): Promise<void> {
  const event = await db.event.findFirst({
    where: { id, status: 'active', publicStatus: 'published' },
    select: { representativeArticleId: true },
  });
  if (event?.representativeArticleId) enqueuePublicArticleView(event.representativeArticleId);
}

export async function listPublicArticleIds(): Promise<Array<{ id: string; updatedAt: Date }>> {
  const events = await db.event.findMany({
    where: publicEventWhere,
    select: {
      id: true,
      lastSeenAt: true,
      representativeArticle: { select: { publicContentUpdatedAt: true } },
    },
  });
  return events.map((event) => ({ id: event.id, updatedAt: event.representativeArticle!.publicContentUpdatedAt ?? event.lastSeenAt }));
}

export async function recordOriginalClick(id: string): Promise<boolean> {
  const event = await db.event.findFirst({
    where: { id, status: 'active', publicStatus: 'published' },
    select: { representativeArticleId: true },
  });
  if (!event?.representativeArticleId) return false;
  enqueuePublicArticleOriginalClick(event.representativeArticleId);
  return true;
}
