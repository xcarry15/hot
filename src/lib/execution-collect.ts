import { collectAllSources, crawlSource } from './pipeline/collect';
import type { CrawlResult } from '@/contracts/crawl';
import { db } from './db';
import { assertJobNotCancelled } from './execution-cancellation';
import { advanceJobProgress, startJobStage } from './job-progress';
import { assertNotAborted } from './worker-stop';

export async function executeCollectJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const sourceId = payload.sourceId as string | undefined;
  const sourceIds = Array.isArray(payload.sourceIds)
    ? [...new Set(payload.sourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 50)
    : [];
  if (sourceIds.length > 0) {
    const results: Array<CrawlResult & { sourceId: string; sourceName: string }> = [];
    if (jobId) await startJobStage(jobId, { stage: 'collect', total: sourceIds.length });
    for (const id of sourceIds) {
      assertNotAborted(signal);
      if (jobId) await assertJobNotCancelled(jobId);
      if (payload.resetSourceHealth === true) {
        await db.source.updateMany({
          where: { id },
          data: { consecutiveFailures: 0, status: 'normal', circuitBreakerUntil: null },
        });
      }
      const result = await collectSingleSource(id, signal);
      results.push(...result.results);
      if (jobId) {
        const sourceResult = result.results[0];
        await advanceJobProgress(jobId, {
          doneDelta: 1,
          errorDelta: sourceResult?.success ? 0 : 1,
          currentItemLabel: sourceResult?.sourceName ?? id,
        });
      }
    }
    return summarizeCollectResult({
      results,
      totalNewArticles: results.reduce((sum, item) => sum + (item.createdCount ?? 0), 0),
      errors: results.filter(item => !item.success).length,
    });
  }
  if (sourceId) {
    if (payload.resetSourceHealth === true) {
      await db.source.update({
        where: { id: sourceId },
        data: {
          consecutiveFailures: 0,
          status: 'normal',
          circuitBreakerUntil: null,
        },
      });
    }
    const collectResult = await collectSingleSource(sourceId, signal, jobId);
    const sourceResult = collectResult.results[0];
    return {
      sourceId,
      result: {
        success: sourceResult?.success ?? false,
        itemsFound: sourceResult?.items.length ?? 0,
        error: sourceResult?.error,
      },
    };
  }
  const result = await collectAllSources(signal, jobId);
  return { result: summarizeCollectResult(result) };
}

export async function collectSingleSource(
  sourceId: string,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Awaited<ReturnType<typeof collectAllSources>>> {
  const source = await db.source.findUnique({ where: { id: sourceId } });
  const sourceName = source?.name || sourceId;
  if (jobId) {
    await startJobStage(jobId, { stage: 'collect', total: 1, currentItemLabel: sourceName });
  }

  let result;
  try {
    result = await crawlSource(sourceId, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    result = { success: false, items: [], error: msg };
  }

  const results = [{ sourceId, sourceName, ...result }];
  if (jobId) {
    await advanceJobProgress(jobId, {
      doneDelta: 1,
      errorDelta: result.success ? 0 : 1,
    });
  }
  return {
    results,
    totalNewArticles: result.createdCount ?? 0,
    errors: result.success ? 0 : 1,
  };
}

export function summarizeCollectResult(
  result: Awaited<ReturnType<typeof collectAllSources>>,
): Record<string, unknown> {
  return {
    totalSources: result.results.length,
    totalNewArticles: result.totalNewArticles,
    errors: result.errors,
    sources: result.results.map(r => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      success: r.success,
      itemsFound: r.items.length,
      newArticles: r.createdCount ?? 0,
      deduplicated: r.deduplicatedCount ?? 0,
      reclaimed: r.reclaimedCount ?? 0,
      error: r.error,
    })),
  };
}
