import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { fetchArticleDetail } from '@/lib/detail-fetcher';
import { buildAiResetDataForArticle } from '@/lib/article-ai-reset';
import { refreshPublicPublication } from '@/lib/public-publication-service';
import { recalculateEventById } from '@/lib/event-service';
import { evaluateKeywordMatch } from '@/lib/filter';

export async function refetchArticle(articleId: string) {
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
  await db.article.update({
    where: { id: articleId },
    data: resetData,
  });
  if (article.eventId) await recalculateEventById(article.eventId);
  await refreshPublicPublication(articleId);
  const content = await fetchArticleDetail(articleId);
  if (content.length === 0) {
    const latest = await db.article.findUnique({ where: { id: articleId }, select: { fetchError: true } });
    return { success: false, contentLength: 0, error: latest?.fetchError || '未获取到有效正文' };
  }
  const keywordMatch = await evaluateKeywordMatch(`${article.title} ${content.slice(0, 1000)}`).catch(() => ({
    configured: false,
    matched: false,
  }));
  await db.article.update({
    where: { id: articleId },
    data: { keywordMatched: keywordMatch.matched },
  });
  return { success: true, contentLength: content.length };
}
