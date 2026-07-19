import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { fetchArticleDetail } from '@/lib/detail-fetcher';
import { buildAiResetDataForArticle } from '@/lib/article-ai-reset';
import { refreshPublicPublication } from '@/lib/public-publication-service';
import { recalculateEventById } from '@/lib/event-service';

export async function refetchArticle(articleId: string) {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      manualOverrides: true,
      manualCorrectedAt: true,
      relevance: true,
      summary: true,
      brand: true,
      category: true,
      tags: true,
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
    fetchRetryCount: 0,
    nextFetchRetryAt: null,
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
  return { success: true, contentLength: content.length };
}
