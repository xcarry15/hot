import { db } from '@/lib/db';

export async function getDiscardedItem(id: string) {
  const item = await db.discardedItem.findUnique({
    where: { id },
    select: { id: true, sourceId: true, title: true, url: true, reason: true, detail: true, winnerArticleId: true, publishedAt: true, createdAt: true, source: { select: { name: true, type: true, url: true } } },
  });
  if (!item) return null;
  let parsedDetail: Record<string, unknown> | null = null;
  if (item.detail) { try { parsedDetail = JSON.parse(item.detail); } catch { parsedDetail = null; } }
  return { ...item, parsedDetail };
}
