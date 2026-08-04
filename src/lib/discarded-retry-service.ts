import { db } from '@/lib/db';
import { randomUUID } from 'node:crypto';
import type { DiscardedItem, Prisma } from '@prisma/client';
import { invalidateKeywordCache } from '@/lib/filter';
import { KEYWORD_DEFAULT_CATEGORY } from '@/contracts/keywords';

const ALLOWED_REASONS = ['filter:keyword'];

export interface RetryDiscardedKeywordInput {
  word?: string;
  category?: string;
}

export interface RetryDiscardedKeywordInfo {
  word: string;
  category: string;
  added: boolean;
}

export type RetryDiscardedResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_reason'; reason: string }
  | { kind: 'existing'; articleId: string; title: string; auditId: string; keyword?: RetryDiscardedKeywordInfo }
  | { kind: 'created'; articleId: string; title: string; auditId: string; keyword?: RetryDiscardedKeywordInfo };

type RetryDbClient = Pick<Prisma.TransactionClient, 'article' | 'discardedItem' | '$executeRaw'>;

async function retryDiscardedItemOnClient(
  client: RetryDbClient,
  id: string,
  initialDiscarded?: DiscardedItem,
): Promise<RetryDiscardedResult> {
  const discarded = initialDiscarded ?? await client.discardedItem.findUnique({ where: { id } });
  if (!discarded) return { kind: 'not_found' };
  if (!ALLOWED_REASONS.includes(discarded.reason)) return { kind: 'invalid_reason', reason: discarded.reason };

  const existing = await client.article.findUnique({ where: { url: discarded.url }, select: { id: true } });
  if (existing) {
    const auditId = randomUUID();
    await client.$executeRaw`INSERT INTO discarded_retry_audits (id, discardedId, sourceId, title, url, reason, detail, winnerArticleId, publishedAt, action, articleId) VALUES (${auditId}, ${discarded.id}, ${discarded.sourceId}, ${discarded.title}, ${discarded.url}, ${discarded.reason}, ${discarded.detail}, ${discarded.winnerArticleId}, ${discarded.publishedAt}, ${'existing'}, ${existing.id})`;
    await client.discardedItem.delete({ where: { id } });
    return { kind: 'existing', articleId: existing.id, title: discarded.title, auditId };
  }

  const articleId = randomUUID();
  const auditId = randomUUID();
  const article = await client.article.create({
    data: {
      id: articleId,
      sourceId: discarded.sourceId, url: discarded.url, title: discarded.title,
      rawContent: '', cleanContent: '', articleBody: '', contentHash: '',
      fetchStatus: 'pending', aiStatus: 'pending', score: 50,
      publishedAt: discarded.publishedAt ?? undefined,
    },
  });
  await client.$executeRaw`INSERT INTO discarded_retry_audits (id, discardedId, sourceId, title, url, reason, detail, winnerArticleId, publishedAt, action, articleId) VALUES (${auditId}, ${discarded.id}, ${discarded.sourceId}, ${discarded.title}, ${discarded.url}, ${discarded.reason}, ${discarded.detail}, ${discarded.winnerArticleId}, ${discarded.publishedAt}, ${'created'}, ${articleId})`;
  await client.discardedItem.delete({ where: { id } });
  return { kind: 'created', articleId: article.id, title: article.title, auditId };
}

export async function retryDiscardedItem(id: string): Promise<RetryDiscardedResult> {
  return db.$transaction((client) => retryDiscardedItemOnClient(client, id));
}

/**
 * 工作台的“添加关键词并采集此文章”是一个复合写操作：
 * 关键词写入和当前 DiscardedItem 恢复必须在同一事务中完成。
 *
 * 这里不能复用通用关键词保存接口，因为通用接口会清理全部 filter:* 记录，
 * 会先把当前操作目标删掉，随后 retry 只能得到“记录不存在”，还会让工作台整批未命中记录消失。
 * 手动操作只消费用户明确选中的这一条，其他未命中记录继续保留在任务中心。
 */
export async function retryDiscardedItemWithKeyword(
  id: string,
  input: RetryDiscardedKeywordInput = {},
): Promise<RetryDiscardedResult> {
  const word = input.word?.trim() ?? '';
  const category = input.category?.trim() || KEYWORD_DEFAULT_CATEGORY;
  let keywordAdded = false;

  const result = await db.$transaction(async (client) => {
    const discarded = await client.discardedItem.findUnique({ where: { id } });
    if (!discarded) return { kind: 'not_found' as const };
    if (!ALLOWED_REASONS.includes(discarded.reason)) {
      return { kind: 'invalid_reason' as const, reason: discarded.reason };
    }

    let keyword: RetryDiscardedKeywordInfo | undefined;
    if (word) {
      const existing = await client.keyword.findUnique({
        where: { category_word: { category, word } },
        select: { id: true },
      });
      await client.keyword.upsert({
        where: { category_word: { category, word } },
        create: { category, word },
        update: {},
      });
      keywordAdded = !existing;
      keyword = { word, category, added: keywordAdded };
    }

    const retryResult = await retryDiscardedItemOnClient(client, id, discarded);
    if (!keyword || retryResult.kind === 'not_found' || retryResult.kind === 'invalid_reason') return retryResult;
    return { ...retryResult, keyword };
  });

  if (keywordAdded) invalidateKeywordCache();
  return result;
}
