import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { splitBrands } from '@/lib/shared/article-codecs';
import { KEYWORD_BLACKLIST_CATEGORY } from '@/contracts/keywords';

type SearchDb = Pick<typeof db, 'article' | 'articleSearch'>;
type KeywordDb = Pick<typeof db, 'keyword' | 'keywordHit'>;

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24_000);
}

export function buildArticleSearchText(article: {
  title: string;
  cleanContent: string;
  summary: string;
  brand: string;
  eventKey: string;
}): string {
  return normalizeSearchText([
    article.title,
    article.summary,
    ...splitBrands(article.brand),
    article.eventKey,
    article.cleanContent,
  ].filter(Boolean).join(' '));
}

export async function refreshArticleSearchIndex(articleId: string, client: SearchDb = db): Promise<void> {
  const article = await client.article.findUnique({
    where: { id: articleId },
    select: { title: true, cleanContent: true, summary: true, brand: true, eventKey: true },
  });
  if (!article) return;
  await client.articleSearch.upsert({
    where: { articleId },
    create: {
      articleId,
      searchText: buildArticleSearchText(article),
    },
    update: {
      searchText: buildArticleSearchText(article),
    },
  });
}

export async function replaceArticleKeywordHits(
  articleId: string,
  matchedWords: readonly string[],
  client: KeywordDb = db,
): Promise<void> {
  const normalizedWords = [...new Set(matchedWords.map((word) => word.trim()).filter(Boolean))];
  await client.keywordHit.deleteMany({ where: { articleId } });
  if (normalizedWords.length === 0) return;

  const keywords = await client.keyword.findMany({
    where: {
      word: { in: normalizedWords },
      category: { not: KEYWORD_BLACKLIST_CATEGORY },
    },
    select: { id: true },
  });
  if (keywords.length === 0) return;
  await client.keywordHit.createMany({
    data: keywords.map((keyword) => ({ articleId, keywordId: keyword.id })),
  });
}

export function buildArticleSearchWhere(search: string): Prisma.ArticleWhereInput {
  const normalized = normalizeSearchText(search);
  if (!normalized) return {};
  return {
    searchIndex: {
      is: {
        searchText: { contains: normalized },
      },
    },
  };
}
