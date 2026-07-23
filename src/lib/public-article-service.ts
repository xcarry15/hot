import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { parseJsonArray, splitBrands, stripHtml } from '@/lib/shared/article-codecs';
import { getPublicDateKey } from '@/lib/shared/public-date';
import { enqueuePublicArticleOriginalClick, enqueuePublicArticleView } from '@/lib/public-view-service';
import {
  publicArticleCountCache,
  publicArticleDetailCache,
  publicArticleListCache,
} from '@/lib/public-article-cache';
import type {
  PublicArticleDateGroupDto,
  PublicArticleDetailDto,
  PublicArticleFeedRevisionDto,
  PublicArticleListItemDto,
  PublicArticleListResponseDto,
  PublicArticleRelatedDto,
} from '@/contracts/public-articles';

const PUBLIC_PAGE_SIZE = 12;
const PUBLIC_CACHE_TTL_MS = 60_000;
const PUBLIC_DETAIL_CACHE_TTL_MS = 30_000;
const PUBLIC_MAX_ROWS_PER_DATE = 250;
const PUBLIC_EXCERPT_MAX_LENGTH = 180;

type PublicArticleListParams = { search?: string; cursor?: string };

type PublicArticleCursor = {
  publicSortAt: Date;
  id: string;
};

const representativeListSelect = {
  id: true,
  title: true,
  originalSource: true,
  summary: true,
  brand: true,
  category: true,
  score: true,
  pinUntil: true,
  publishedAt: true,
  createdAt: true,
  source: { select: { id: true, name: true, type: true } },
} as const;

const representativeDetailSelect = {
  ...representativeListSelect,
  url: true,
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
  clusterReviewStatus: 'confirmed',
  publicStatus: 'published',
  representativeArticleId: { not: null },
  representativeArticle: { is: { aiStatus: 'done', clusterStatus: 'clustered' } },
} as const;

function normalizeText(value: string | undefined, maxLength: number): string {
  return value?.trim().slice(0, maxLength) ?? '';
}

function toExcerpt(summary: string, cleanContent = ''): string {
  const text = (summary || stripHtml(cleanContent)).replace(/\s+/g, ' ').trim();
  return text.length > PUBLIC_EXCERPT_MAX_LENGTH
    ? `${text.slice(0, PUBLIC_EXCERPT_MAX_LENGTH)}…`
    : text;
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
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, cleanContent),
    brand: article.brand,
    category: article.category,
    score: article.score,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: row.firstSeenAt.toISOString(),
    sourceCount: row.articleCount,
    source: article.source,
  };
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

function encodeCursor(row: { publicSortAt: Date | null; id: string }): string | null {
  if (!row.publicSortAt) return null;
  return Buffer.from(JSON.stringify([row.publicSortAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(value: string | undefined): PublicArticleCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const publicSortAt = new Date(parsed[0]);
    if (Number.isNaN(publicSortAt.getTime()) || !parsed[1]) return null;
    return { publicSortAt, id: parsed[1] };
  } catch {
    return null;
  }
}

function buildSearchWhere(search: string) {
  return search ? {
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
}

async function countPublicArticles(search: string): Promise<number> {
  const key = search;
  const existing = publicArticleCountCache.get(key);
  if (existing) return existing.value;
  const value = db.event.count({
    where: {
      ...publicEventWhere,
      ...buildSearchWhere(search),
    },
  });
  publicArticleCountCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  void value.catch(() => publicArticleCountCache.delete(key));
  return value;
}

async function buildList(params: PublicArticleListParams): Promise<PublicArticleListResponseDto> {
  const search = normalizeText(params.search, 100);
  const cursor = decodeCursor(params.cursor);
  const searchWhere = buildSearchWhere(search);
  const feedWhere = {
    ...publicEventWhere,
    ...(cursor ? {
      OR: [
        { publicSortAt: { lt: cursor.publicSortAt } },
        { publicSortAt: cursor.publicSortAt, id: { lt: cursor.id } },
      ],
    } : {}),
    ...searchWhere,
  };
  const rows = await db.event.findMany({
    where: feedWhere,
    select: {
      id: true,
      firstSeenAt: true,
      lastSeenAt: true,
      articleCount: true,
      publicSortAt: true,
      representativeArticle: { select: representativeListSelect },
    },
    orderBy: [{ publicSortAt: 'desc' }, { id: 'desc' }],
    take: PUBLIC_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > PUBLIC_PAGE_SIZE;
  const eligible = rows.slice(0, PUBLIC_PAGE_SIZE);
  const grouped = new Map<string, PublicEventListRow[]>();
  for (const row of eligible) {
    const key = getPublicDateKey(effectiveDate(row));
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  const groups: PublicArticleDateGroupDto[] = [...grouped.entries()].map(([date, dateRows]) => ({
    date,
    count: dateRows.length,
    items: dateRows.map((row) => serializeEvent(row)),
  }));
  const total = await countPublicArticles(search);
  const lastRow = eligible.at(-1);
  return {
    total,
    groups,
    displayedArticleCount: groups.reduce((count, group) => count + group.items.length, 0),
    displayedDateCount: groups.length,
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    hasMore,
  };
}

export async function getPublicArticleFeedRevision(params: Pick<PublicArticleListParams, 'search'> = {}): Promise<PublicArticleFeedRevisionDto> {
  const search = normalizeText(params.search, 100);
  return { total: await countPublicArticles(search) };
}

export async function listPublicArticles(params: PublicArticleListParams = {}): Promise<PublicArticleListResponseDto> {
  const key = JSON.stringify({ search: normalizeText(params.search, 100), cursor: params.cursor ?? '' });
  const existing = publicArticleListCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const value = buildList(params);
  publicArticleListCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  void value.catch(() => publicArticleListCache.delete(key));
  return value;
}

async function buildPublicArticleDetail(id: string): Promise<PublicArticleDetailDto | null> {
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
    url: article.url,
    summary: article.summary,
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

export async function getPublicArticleDetail(id: string): Promise<PublicArticleDetailDto | null> {
  const existing = publicArticleDetailCache.get(id);
  if (existing) return existing.value;
  const value = buildPublicArticleDetail(id);
  publicArticleDetailCache.set(id, { value, expiresAt: Date.now() + PUBLIC_DETAIL_CACHE_TTL_MS });
  void value.catch(() => publicArticleDetailCache.delete(id));
  return value;
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
