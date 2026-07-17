import { db } from '@/lib/db';
import { fetchArticleDetail } from '@/lib/detail-fetcher';
import { buildAiResetDataForArticle } from '@/lib/article-duplicate-state';
import { refreshPublicPublication } from '@/lib/public-publication-service';

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
    },
  });
  if (!article) return null;
  await db.article.update({
    where: { id: articleId },
    data: {
      ...buildAiResetDataForArticle(article, { dedupOverride: 'preserve' }),
      fetchStatus: 'pending',
    },
  });
  await refreshPublicPublication(articleId);
  const content = await fetchArticleDetail(articleId);
  return { success: true, contentLength: content.length };
}
