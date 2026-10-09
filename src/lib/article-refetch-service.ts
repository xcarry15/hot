import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { ARTICLE_FETCH_TIMEOUT_MS, fetchArticleDetail, markArticleFetchFailure } from '@/lib/detail-fetcher';
import { buildAiResetDataForArticle } from '@/lib/article-ai-reset';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshEventPublicPublication, refreshPublicPublication } from '@/lib/public-publication-service';
import { recalculateEventsInTransaction } from '@/lib/event-service';
import { evaluateKeywordMatch } from '@/lib/filter';
import { persistArticleKeywordMatch, replaceArticleKeywordHits } from '@/lib/keyword-hit-service';
import { assertWorkerCanWrite } from '@/lib/execution-write-guard';
import { assertNotAborted } from '@/lib/worker-stop';
import { withTimeout } from '@/lib/shared/async';

export async function refetchArticle(articleId: string, signal?: AbortSignal) {
  await assertWorkerCanWrite(signal);
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      title: true,
      manualOverrides: true,
      manualCorrectedAt: true,
      relevance: true,
      summary: true,
      brand: true,
      category: true,
      eventSubjects: true,
      eventAction: true,
      eventObject: true,
      keyPoints: true,
      eventScore: true,
      contentScore: true,
      adProbability: true,
      isAd: true,
      eventId: true,
    },
  });
  if (!article) return null;
  await assertWorkerCanWrite(signal);
  const resetData: Prisma.ArticleUpdateInput = {
    ...buildAiResetDataForArticle(article),
    fetchStatus: 'pending',
    fetchError: null,
    fetchRetryCount: 0,
    nextFetchRetryAt: null,
    keywordMatched: false,
    technicalIgnoredAt: null,
    event: { disconnect: true },
    clusterStatus: 'pending',
    clusteredAt: null,
    clusterError: null,
    clusterRetryCount: 0,
    nextClusterRetryAt: null,
    eventKey: '',
  };
  await db.$transaction(async (tx) => {
    await assertWorkerCanWrite(signal);
    await tx.article.update({
      where: { id: articleId },
      data: resetData,
    });
    await replaceArticleKeywordHits(articleId, [], tx);
    if (article.eventId) {
      await recalculateEventsInTransaction(tx, [article.eventId]);
      await refreshEventPublicPublication(article.eventId, tx);
    }
    await refreshPublicPublication(articleId, tx);
    await assertWorkerCanWrite(signal);
  }, { maxWait: 10_000, timeout: 10_000 });
  invalidatePublicArticleCache();
  assertNotAborted(signal);
  let content: string;
  try {
    content = await withTimeout(
      timeoutSignal => fetchArticleDetail(articleId, 2, timeoutSignal),
      ARTICLE_FETCH_TIMEOUT_MS,
      '正文重新获取超时',
      signal,
    );
  } catch (error) {
    await assertWorkerCanWrite(signal);
    await markArticleFetchFailure(articleId, error, { onlyIfPending: true });
    throw error;
  }
  assertNotAborted(signal);
  if (content.length === 0) {
    const latest = await db.article.findUnique({ where: { id: articleId }, select: { fetchError: true } });
    return { success: false, contentLength: 0, error: latest?.fetchError || '未获取到有效正文' };
  }
  const keywordMatch = await evaluateKeywordMatch(`${article.title} ${content}`).catch((error: unknown) => {
    console.error(`[article-refetch] keyword matching failed for ${articleId}:`, error);
    return {
      configured: false,
      matched: false,
      matchedWords: [],
    };
  });
  await persistArticleKeywordMatch(articleId, keywordMatch, signal);
  return { success: true, contentLength: content.length };
}
