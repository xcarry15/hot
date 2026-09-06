import { db } from '@/lib/db';
import { KEYWORD_BLACKLIST_CATEGORY } from '@/contracts/keywords';

type KeywordDb = Pick<typeof db, 'keyword' | 'keywordHit'>;

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
