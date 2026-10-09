import { db } from '@/lib/db';
import { KEYWORD_BLACKLIST_CATEGORY } from '@/contracts/keywords';
import type { KeywordMatchResult } from '@/lib/filter';
import { assertWorkerCanWrite } from '@/lib/execution-write-guard';

export const KEYWORD_HIT_COUNT_WINDOW_DAYS = 90;

type KeywordDb = Pick<typeof db, 'keyword' | 'keywordHit'>;

export async function replaceArticleKeywordHits(
  articleId: string,
  matchedWords: readonly string[],
  client: KeywordDb,
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

/** Commit the processing result and its hit details together, including cancellation. */
export async function persistArticleKeywordMatch(
  articleId: string,
  match: Pick<KeywordMatchResult, 'matched' | 'matchedWords'>,
  signal?: AbortSignal,
): Promise<void> {
  await assertWorkerCanWrite(signal);
  await db.$transaction(async (transaction) => {
    await assertWorkerCanWrite(signal);
    await transaction.article.update({
      where: { id: articleId },
      data: { keywordMatched: match.matched },
    });
    await replaceArticleKeywordHits(articleId, match.matchedWords, transaction);
    await assertWorkerCanWrite(signal);
  }, { maxWait: 10_000, timeout: 10_000 });
}

/**
 * Rebuild recent whitelist hit details from stored article text and the current keyword list.
 * Keyword deletion cascades KeywordHit rows, so XLSX re-import alone cannot restore these counts.
 */
export async function rebuildRecentArticleKeywordHits(): Promise<number> {
  const cutoff = Date.now() - KEYWORD_HIT_COUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      DELETE FROM keyword_hits
      WHERE articleId IN (
        SELECT a.id
        FROM articles AS a
        INNER JOIN sources AS s ON s.id = a.sourceId
        WHERE a.createdAt >= ${cutoff}
          AND a.fetchStatus = 'fetched'
          AND a.cleanContent <> ''
          AND s.deletedAt IS NULL
      )
    `;

    return transaction.$executeRaw`
      INSERT INTO keyword_hits (articleId, keywordId, createdAt)
      SELECT a.id, k.id, a.createdAt
      FROM articles AS a
      INNER JOIN sources AS s ON s.id = a.sourceId AND s.deletedAt IS NULL
      INNER JOIN keywords AS k
      WHERE a.createdAt >= ${cutoff}
        AND a.fetchStatus = 'fetched'
        AND a.cleanContent <> ''
        AND k.word <> ''
        AND k.category <> ${KEYWORD_BLACKLIST_CATEGORY}
        AND instr(lower(a.title || ' ' || a.cleanContent), lower(k.word)) > 0
    `;
  }, { maxWait: 10_000, timeout: 30_000 });
}
