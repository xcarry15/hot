import type { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';

export const AI_INVOCATION_OPERATION = 'article_analysis';

export type AIInvocationOutcome = 'success' | 'error';

export interface RecordAIInvocationInput {
  articleId: string;
  jobId?: string;
  provider: string;
  model: string;
  outcome: AIInvocationOutcome;
  errorKind?: string;
  statusCode?: number;
  durationMs: number;
}

export interface AIInvocationStats {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  averageDurationMs: number;
  failuresByKind: Array<{ kind: string; count: number }>;
  byProvider: Array<{
    provider: string;
    model: string;
    total: number;
    succeeded: number;
    failed: number;
    averageDurationMs: number;
  }>;
}

type AIInvocationDb = Pick<PrismaClient, 'aiInvocation'>;

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(value: number, denominator: number): number {
  return denominator > 0 ? round(value / denominator, 4) : 0;
}

/** 记录失败不能影响文章分析主流程；调用方通常以 void + catch 使用。 */
export async function recordAIInvocation(
  input: RecordAIInvocationInput,
  database: AIInvocationDb = db,
): Promise<void> {
  await database.aiInvocation.create({
    data: {
      articleId: input.articleId,
      jobId: input.jobId,
      operation: AI_INVOCATION_OPERATION,
      provider: input.provider,
      model: input.model,
      outcome: input.outcome,
      errorKind: input.errorKind ?? '',
      statusCode: input.statusCode,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    },
  });
}

export async function getAIInvocationStats(
  startAt: Date | null,
  endAt: Date,
  sourceId?: string,
  database: AIInvocationDb = db,
): Promise<AIInvocationStats> {
  const rows = await database.aiInvocation.groupBy({
    by: ['provider', 'model', 'outcome', 'errorKind'],
    where: {
      operation: AI_INVOCATION_OPERATION,
      createdAt: {
        ...(startAt ? { gte: startAt } : {}),
        lte: endAt,
      },
      ...(sourceId ? { article: { sourceId } } : {}),
    },
    _count: { _all: true },
    _avg: { durationMs: true },
  });

  const providerStats = new Map<string, AIInvocationStats['byProvider'][number]>();
  let total = 0;
  let succeeded = 0;
  let durationTotal = 0;
  const failuresByKind = new Map<string, number>();

  for (const row of rows) {
    const count = row._count._all;
    const averageDurationMs = row._avg.durationMs ?? 0;
    const key = `${row.provider}\u0000${row.model}`;
    const current = providerStats.get(key) ?? {
      provider: row.provider,
      model: row.model,
      total: 0,
      succeeded: 0,
      failed: 0,
      averageDurationMs: 0,
    };
    current.total += count;
    if (row.outcome === 'success') current.succeeded += count;
    else {
      current.failed += count;
      const kind = row.errorKind || 'unknown';
      failuresByKind.set(kind, (failuresByKind.get(kind) ?? 0) + count);
    }
    current.averageDurationMs = current.total > 0
      ? round((current.averageDurationMs * (current.total - count) + averageDurationMs * count) / current.total)
      : 0;
    providerStats.set(key, current);
    total += count;
    succeeded += row.outcome === 'success' ? count : 0;
    durationTotal += averageDurationMs * count;
  }

  return {
    total,
    succeeded,
    failed: total - succeeded,
    successRate: ratio(succeeded, total),
    averageDurationMs: total > 0 ? round(durationTotal / total) : 0,
    failuresByKind: [...failuresByKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    byProvider: [...providerStats.values()].sort((left, right) => (
      right.total - left.total
      || left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model)
    )),
  };
}
