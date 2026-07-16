import { db } from '@/lib/db';
import { fetchArticleDetail } from '@/lib/detail-fetcher';
import { buildAiResetData } from '@/lib/article-duplicate-state';
import { refreshPublicPublication } from '@/lib/public-publication-service';

export async function refetchArticle(articleId: string) {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { id: true } });
  if (!article) return null;
  await db.article.update({
    where: { id: articleId },
    data: {
      ...buildAiResetData(),
      fetchStatus: 'pending',
    },
  });
  await refreshPublicPublication(articleId);
  const content = await fetchArticleDetail(articleId);
  return { success: true, contentLength: content.length };
}
