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
  PublicArticleRelatedDto,
} from '@/contracts/public-articles';

const PUBLIC_INITIAL_DATE_LIMIT = 3;
const PUBLIC_SEARCH_DATE_LIMIT = 10;
const PUBLIC_LOAD_MORE_DATE_LIMIT = 3;
const PUBLIC_CACHE_TTL_MS = 60_000;

type PublicArticleListParams = { search?: string; before?: string; dateLimit?: number };

const representativeSelect = {
  id: true,
  url: true,
  title: true,
  originalSource: true,
  cleanContent: true,
  summary: true,
  brand: true,
  category: true,
  tags: true,
  keyPoints: true,
  score: true,
  pinUntil: true,
  publishedAt: true,
  createdAt: true,
  publicContentUpdatedAt: true,
  source: { select: { id: true, name: true, type: true } },
} as const;

type PublicEventRow = Awaited<ReturnType<typeof loadPublishedEvents>>[number];

function normalizeText(value: string | undefined, maxLength: number): string {
  return value?.trim().slice(0, maxLength) ?? '';
}

function toExcerpt(summary: string, cleanContent: string): string {
  if (summary) return summary;
  const text = stripHtml(cleanContent).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function effectiveDate(row: PublicEventRow): Date {
  return row.representativeArticle!.publishedAt ?? row.firstSeenAt;
}

function serializeEvent(row: PublicEventRow): PublicArticleListItemDto {
  const article = row.representativeArticle!;
  return {
    id: row.id,
    url: article.url,
    title: article.title,
    originalSource: article.originalSource,
    excerpt: toExcerpt(article.summary, article.cleanContent),
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

function matchesSearch(row: PublicEventRow, search: string): boolean {
  if (!search) return true;
  const article = row.representativeArticle!;
  return `${article.title}\n${article.summary}\n${article.brand}`.toLowerCase().includes(search.toLowerCase());
}

function sortEvents(left: PublicEventRow, right: PublicEventRow): number {
  const dateKey = getPublicDateKey(effectiveDate(right)).localeCompare(getPublicDateKey(effectiveDate(left)));
  if (dateKey !== 0) return dateKey;
  const now = Date.now();
  const leftPinned = (left.representativeArticle?.pinUntil?.getTime() ?? 0) > now;
  const rightPinned = (right.representativeArticle?.pinUntil?.getTime() ?? 0) > now;
  if (leftPinned !== rightPinned) return Number(rightPinned) - Number(leftPinned);
  return effectiveDate(right).getTime() - effectiveDate(left).getTime();
}

async function loadPublishedEvents() {
  return db.event.findMany({
    where: {
      status: 'active',
      publicStatus: 'published',
      representativeArticleId: { not: null },
      representativeArticle: { is: { publicStatus: 'published', aiStatus: 'done' } },
    },
    select: {
      id: true,
      firstSeenAt: true,
      lastSeenAt: true,
      articleCount: true,
      representativeArticle: { select: representativeSelect },
    },
  });
}

function dateLimit(params: PublicArticleListParams, hasSearch: boolean): number {
  const fallback = params.before ? PUBLIC_LOAD_MORE_DATE_LIMIT : hasSearch ? PUBLIC_SEARCH_DATE_LIMIT : PUBLIC_INITIAL_DATE_LIMIT;
  return Math.max(1, Math.min(PUBLIC_SEARCH_DATE_LIMIT, Math.floor(params.dateLimit ?? fallback)));
}

async function buildList(params: PublicArticleListParams): Promise<PublicArticleListResponseDto> {
  const search = normalizeText(params.search, 100);
  const before = params.before && /^\d{4}-\d{2}-\d{2}$/.test(params.before) ? params.before : '';
  const all = (await loadPublishedEvents()).filter((row) => matchesSearch(row, search)).sort(sortEvents);
  const eligible = before ? all.filter((row) => getPublicDateKey(effectiveDate(row)) < before) : all;
  const grouped = new Map<string, PublicEventRow[]>();
  for (const row of eligible) {
    const key = getPublicDateKey(effectiveDate(row));
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  const dates = [...grouped.keys()].sort((a, b) => b.localeCompare(a));
  const selectedDates = dates.slice(0, dateLimit(params, Boolean(search)));
  const groups: PublicArticleDateGroupDto[] = selectedDates.map((date) => {
    const rows = grouped.get(date) ?? [];
    return { date, count: rows.length, items: rows.map(serializeEvent) };
  });
  const items = groups.flatMap((group) => group.items);
  return {
    total: all.length,
    items,
    groups,
    displayedArticleCount: items.length,
    displayedDateCount: groups.length,
    nextDate: selectedDates.at(-1) ?? null,
    hasMore: dates.length > selectedDates.length,
  };
}

export async function getPublicArticleFeedRevision(params: Pick<PublicArticleListParams, 'search'> = {}): Promise<PublicArticleFeedRevisionDto> {
  const search = normalizeText(params.search, 100);
  return { total: (await loadPublishedEvents()).filter((row) => matchesSearch(row, search)).length };
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

export async function getPublicArticleDetail(id: string, options: { recordView?: boolean } = {}): Promise<PublicArticleDetailDto | null> {
  const rows = (await loadPublishedEvents()).sort(sortEvents);
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  const row = rows[index];
  const article = row.representativeArticle!;
  if (options.recordView) enqueuePublicArticleView(article.id);
  const brands = splitBrands(article.brand).filter(Boolean);
  const relatedRows = rows
    .filter((candidate) => candidate.id !== row.id && brands.some((brand) => candidate.representativeArticle!.brand.includes(brand)))
    .slice(0, 5);
  const related: PublicArticleRelatedDto[] = relatedRows.map((candidate) => ({
    id: candidate.id,
    title: candidate.representativeArticle!.title,
    score: candidate.representativeArticle!.score,
    publishedAt: candidate.representativeArticle!.publishedAt?.toISOString() ?? null,
    createdAt: candidate.firstSeenAt.toISOString(),
    source: candidate.representativeArticle!.source,
  }));
  const sources = await db.article.findMany({
    where: { eventId: row.id },
    select: { id: true, title: true, url: true, publishedAt: true, createdAt: true, source: { select: { name: true, type: true } } },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
  });
  return {
    ...serializeEvent(row),
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
      previous: index > 0 ? { id: rows[index - 1].id, title: rows[index - 1].representativeArticle!.title } : null,
      next: index + 1 < rows.length ? { id: rows[index + 1].id, title: rows[index + 1].representativeArticle!.title } : null,
    },
  };
}

export async function listPublicArticleIds(): Promise<Array<{ id: string; updatedAt: Date }>> {
  const events = await loadPublishedEvents();
  return events.map((event) => ({ id: event.id, updatedAt: event.representativeArticle!.publicContentUpdatedAt ?? event.lastSeenAt }));
}

export async function recordOriginalClick(id: string): Promise<boolean> {
  const event = await db.event.findFirst({
    where: { id, status: 'active', publicStatus: 'published' },
    select: { representativeArticleId: true },
  });
  if (!event?.representativeArticleId) return false;
  await db.$executeRaw`UPDATE "articles" SET "originalClickCount" = "originalClickCount" + 1 WHERE "id" = ${event.representativeArticleId}`;
  return true;
}
