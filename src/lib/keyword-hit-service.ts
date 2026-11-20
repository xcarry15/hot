import { db } from '@/lib/db';
import { KEYWORD_BLACKLIST_CATEGORY } from '@/contracts/keywords';
import type { KeywordFilterDecision } from '@/contracts/keywords';
import type { KeywordMatchResult } from '@/lib/filter';
import { assertWorkerCanWrite } from '@/lib/execution-write-guard';

export const KEYWORD_HIT_COUNT_WINDOW_DAYS = 90;

type KeywordDb = Pick<typeof db, 'keyword' | 'keywordHit'>;

export type ArticleKeywordDecision = Pick<
  KeywordFilterDecision,
  'industryTitleMatched' | 'retentionReason'
>;

const DEFAULT_ARTICLE_KEYWORD_DECISION: ArticleKeywordDecision = {
  industryTitleMatched: false,
  retentionReason: '',
};

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

/**
 * 提交关键词判定结果与命中明细（含取消检查）。
 *
 * keywordMatched 仍然只表示「白名单命中」，不改成 retained，避免改变既有评分与
 * 导出语义；P1-21 新增 industryTitleMatched / keywordRetentionReason 两个审计字段，
 * 把「行业标题信号救回」「未配置白名单」「黑名单」「未命中」等决策落库，
 * 供 Excel 与后续排查解释。评分策略仍只对 keywordMatched=true 施加确定性加分。
 */
export async function persistArticleKeywordMatch(
  articleId: string,
  match: Pick<KeywordMatchResult, 'matched' | 'matchedWords'>,
  signal?: AbortSignal,
  decision: ArticleKeywordDecision = DEFAULT_ARTICLE_KEYWORD_DECISION,
): Promise<void> {
  await assertWorkerCanWrite(signal);
  await db.$transaction(async (transaction) => {
    await assertWorkerCanWrite(signal);
    await transaction.article.update({
      where: { id: articleId },
      data: {
        keywordMatched: match.matched,
        industryTitleMatched: decision.industryTitleMatched,
        keywordRetentionReason: decision.retentionReason,
      },
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
