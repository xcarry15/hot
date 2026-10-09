import { z } from 'zod';
import { db } from '@/lib/db';
import { InvalidParserConfigError, serializeParserConfig } from '@/lib/source-config';
import { sourceUpdateSchema } from '@/lib/source-schema';
import { invalidatePublicArticleCache } from '@/lib/public-article-cache';
import { refreshPublicPublicationsForSource } from '@/lib/public-publication-service';
import { sourceIdentityUrl } from '@/lib/source-identity';
import { markSourceRepresentativesDirty, releaseSourceRepresentatives } from '@/lib/event/event-consistency-service';
import type { Prisma } from '@prisma/client';

export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;

export class DuplicateSourceIdentityError extends Error {
  readonly status = 409;
  readonly exposeToClient = true;

  constructor(name: string) {
    super(`数据源已存在：${name}`);
    this.name = 'DuplicateSourceIdentityError';
  }
}

export class SourceNotFoundError extends Error {
  readonly status = 404;
  readonly exposeToClient = true;

  constructor() {
    super('数据源不存在或已删除');
    this.name = 'SourceNotFoundError';
  }
}

async function assertActiveSource(id: string, client: Pick<Prisma.TransactionClient, 'source'> = db) {
  const source = await client.source.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, publicEnabled: true },
  });
  if (!source) throw new SourceNotFoundError();
  return source;
}

export async function getSourceDetail(id: string) {
  const source = await db.source.findUnique({ where: { id }, include: { _count: { select: { articles: true } } } });
  if (!source || source.deletedAt) return null;
  const recentLogs = await db.fetchLog.findMany({ where: { sourceId: id, status: 'failure' }, orderBy: { createdAt: 'desc' }, take: 5 });
  return {
    ...source,
    articleCount: source._count.articles,
    recentErrors: recentLogs.map((log) => ({ message: log.errorMessage, time: log.createdAt })),
  };
}

export async function updateSource(id: string, input: SourceUpdateInput) {
  await assertActiveSource(id);
  if (input.url !== undefined) {
    const normalizedUrl = sourceIdentityUrl(input.url);
    const existingSources = await db.source.findMany({
      where: { deletedAt: null, id: { not: id } },
      select: { name: true, url: true },
    });
    const duplicate = existingSources.find((source) => sourceIdentityUrl(source.url) === normalizedUrl);
    if (duplicate) throw new DuplicateSourceIdentityError(duplicate.name);
  }
  const data: Prisma.SourceUpdateInput = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.url !== undefined && { url: input.url }),
    ...(input.parserConfig !== undefined && { parserConfig: serializeParserConfig(input.parserConfig) }),
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.publicEnabled !== undefined && { publicEnabled: input.publicEnabled }),
  };
  const source = input.publicEnabled === undefined
    ? await db.source.update({ where: { id }, data })
    : await db.$transaction(async (tx) => {
      const current = await assertActiveSource(id, tx);
      const updated = await tx.source.update({ where: { id }, data });
      if (current.publicEnabled !== input.publicEnabled) {
        await markSourceRepresentativesDirty(tx, id, 'source-publication-changed');
      }
      return updated;
    }, { maxWait: 10_000, timeout: 10_000 });
  // 先提交来源状态，再分批同步派生公开快照；不能把整来源文章放进同一事务。
  if (input.publicEnabled !== undefined) {
    // 先清掉详情/列表缓存。即使后续派生同步因锁或进程故障中断，
    // 公开读取也不会继续命中旧的已公开内容。
    invalidatePublicArticleCache();
    await refreshPublicPublicationsForSource(id);
  }
  return source;
}

export async function softDeleteSource(id: string) {
  const source = await db.$transaction(async (tx) => {
    await assertActiveSource(id, tx);
    const deleted = await tx.source.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
    await releaseSourceRepresentatives(tx, id);
    return deleted;
  }, { maxWait: 10_000, timeout: 10_000 });
  invalidatePublicArticleCache();
  await refreshPublicPublicationsForSource(id);
  return source;
}

export { InvalidParserConfigError };
