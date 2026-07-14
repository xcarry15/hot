import { db } from '@/lib/db';
import { randomUUID } from 'node:crypto';

const ALLOWED_REASONS = ['filter:keyword', 'dedup:near', 'dedup:content', 'dedup:entity'];

export type RetryDiscardedResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_reason'; reason: string }
  | { kind: 'existing'; articleId: string; title: string; auditId: string }
  | { kind: 'created'; articleId: string; title: string; auditId: string };

export async function retryDiscardedItem(id: string): Promise<RetryDiscardedResult> {
  const discarded = await db.discardedItem.findUnique({ where: { id } });
  if (!discarded) return { kind: 'not_found' };
  if (!ALLOWED_REASONS.includes(discarded.reason)) return { kind: 'invalid_reason', reason: discarded.reason };

  const existing = await db.article.findUnique({ where: { url: discarded.url }, select: { id: true } });
  if (existing) {
    const auditId = randomUUID();
    await db.$transaction([
      db.$executeRaw`INSERT INTO discarded_retry_audits (id, discardedId, sourceId, title, url, reason, detail, winnerArticleId, publishedAt, action, articleId) VALUES (${auditId}, ${discarded.id}, ${discarded.sourceId}, ${discarded.title}, ${discarded.url}, ${discarded.reason}, ${discarded.detail}, ${discarded.winnerArticleId}, ${discarded.publishedAt}, ${'existing'}, ${existing.id})`,
      db.discardedItem.delete({ where: { id } }),
    ]);
    return { kind: 'existing', articleId: existing.id, title: discarded.title, auditId };
  }

  const articleId = randomUUID();
  const auditId = randomUUID();
  const [article] = await db.$transaction([
    db.article.create({
      data: {
        id: articleId,
        sourceId: discarded.sourceId, url: discarded.url, title: discarded.title,
        rawContent: '', cleanContent: '', articleBody: '', contentHash: '',
        fetchStatus: 'pending', aiStatus: 'pending', score: 50,
        publishedAt: discarded.publishedAt ?? undefined,
      },
    }),
    db.$executeRaw`INSERT INTO discarded_retry_audits (id, discardedId, sourceId, title, url, reason, detail, winnerArticleId, publishedAt, action, articleId) VALUES (${auditId}, ${discarded.id}, ${discarded.sourceId}, ${discarded.title}, ${discarded.url}, ${discarded.reason}, ${discarded.detail}, ${discarded.winnerArticleId}, ${discarded.publishedAt}, ${'created'}, ${articleId})`,
    db.discardedItem.delete({ where: { id } }),
  ]);
  return { kind: 'created', articleId: article.id, title: article.title, auditId };
}
