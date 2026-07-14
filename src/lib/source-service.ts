import { z } from 'zod';
import { db } from '@/lib/db';
import { InvalidParserConfigError, serializeParserConfig } from '@/lib/source-config';
import { sourceUpdateSchema } from '@/lib/source-schema';

export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;

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
  return db.source.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.url !== undefined && { url: input.url }),
      ...(input.parserConfig !== undefined && { parserConfig: serializeParserConfig(input.parserConfig) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}

export async function softDeleteSource(id: string) {
  return db.source.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
}

export { InvalidParserConfigError };
