import { db } from '@/lib/db';
import { recordFeishuEventOriginalClick } from '@/lib/public-view-service';
import { isHttpUrl } from '@/lib/url-utils';

export async function resolveFeishuOriginal(articleId: string, countClick: boolean): Promise<string | null> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: { url: true, eventId: true, sourceId: true },
  });
  if (!article || !isHttpUrl(article.url)) return null;
  if (countClick && article.eventId) {
    try {
      await recordFeishuEventOriginalClick(article.eventId, article.sourceId);
    } catch {
      console.warn('[feishu-original] Failed to record original article click');
    }
  }
  return new URL(article.url).href;
}
