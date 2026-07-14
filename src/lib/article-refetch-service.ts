import { db } from '@/lib/db';
import { fetchArticleDetail } from '@/lib/detail-fetcher';

export async function refetchArticle(articleId: string) {
  await db.article.update({ where: { id: articleId }, data: { fetchStatus: 'pending' } });
  const content = await fetchArticleDetail(articleId);
  return { success: true, contentLength: content.length };
}
