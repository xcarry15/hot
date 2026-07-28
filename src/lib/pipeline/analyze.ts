/**
 * Pipeline / analyze 阶段应用服务。
 *
 * 单一职责：
 *   - 抓取 aiStatus ∈ {pending,failed} 且退避到期（nextAiRetryAt 已到或为空）
 *     → processWithAI 批处理
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts.analyzeAllPending`；B13 抽离后保留：
 *     · MAX_BATCH_SIZE=500、CONCURRENCY=ai_concurrency(默认3)/DELAY_MS=300、timeout=90_000
 *     · 退避 where：OR[ nextAiRetryAt=null, nextAiRetryAt <= now ]
 *     · Promise.allSettled 把 rejected 计入 errors
 */
import type { Article, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { processWithAI } from '@/lib/ai';
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { assertNotAborted } from '@/lib/worker-stop';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';

const AI_TIMEOUT_MS = 90_000;
const MAX_BATCH_SIZE = 500;
const DEFAULT_AI_CONCURRENCY = 3;
const MIN_AI_CONCURRENCY = 1;
const MAX_AI_CONCURRENCY = 10;
const AI_DELAY_MS = 300;
const AI_PROVIDER_RETRY_DELAY_MS = 2 * 60 * 1000;
const AI_RATE_LIMIT_RETRY_DELAY_MS = 5 * 60 * 1000;

function isTransientBatchError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /AI分析超时|timeout|timed out|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(message);
}

/**
 * Stage 3: Run AI for fetched, not-yet-clustered articles with aiStatus=pending or failed.
 * Batches with concurrency from settings.ai_concurrency (1-10, default 3)
 * and 300ms delay between batches.
 */
export async function analyzeAllPending(signal?: AbortSignal, jobId?: string, forceRetry = false): Promise<{
  total: number;
  processed: number;
  errors: number;
  deferred: number;
  providerUnavailable: boolean;
  providerPaused: boolean;
}> {
  assertNotAborted(signal);

  const pendingWhere: Prisma.ArticleWhereInput = {
    aiStatus: { in: ['pending', 'failed'] },
    fetchStatus: 'fetched',
    technicalIgnoredAt: null,
    eventId: null,
    clusterStatus: 'pending',
    ...(forceRetry ? {} : {
      OR: [
        { nextAiRetryAt: null },
        { nextAiRetryAt: { lte: new Date() } },
      ],
    }),
  };
  const pendingIds = await db.article.findMany({ where: pendingWhere, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const total = pendingIds.length;
  if (jobId) await startJobStage(jobId, { stage: 'ai', total });

  const articleSelect = {
      id: true,
      title: true,
      sourceId: true,
      cleanContent: true,
      articleBody: true,
      rawContent: true,
      fetchStatus: true,
      publishedAt: true,
      createdAt: true,
      aiStatus: true,
      aiRetryCount: true,
      relevance: true,
      summary: true,
      brand: true,
      category: true,
      eventSubjects: true,
      eventAction: true,
      eventObject: true,
      eventKey: true,
      eventKeyConfidence: true,
      keyPoints: true,
      score: true,
      keywordMatched: true,
      eventScore: true,
      contentScore: true,
      rawScore: true,
      adProbability: true,
      aiConfidence: true,
      isAd: true,
      manualOverrides: true,
      aiSnapshot: true,
      manualCorrectedAt: true,
  } as const;

  let processed = 0;
  let errors = 0;
  let deferred = 0;
  // AI 并发可配置（设置项 ai_concurrency，默认 3，范围 1-10）。
  // 调高可缩短批处理时间但撞 429 风险增大；provider 故障时降低可减少无效请求。
  const rawConcurrency = parseInt(await getSetting(SETTING_KEYS.AI_CONCURRENCY) || String(DEFAULT_AI_CONCURRENCY), 10);
  const concurrency = Math.max(
    MIN_AI_CONCURRENCY,
    Math.min(MAX_AI_CONCURRENCY, Number.isFinite(rawConcurrency) ? rawConcurrency : DEFAULT_AI_CONCURRENCY),
  );

  const attemptedIds = new Set<string>();
  const retryablePausedIds = new Set<string>();
  let providerPause: { retryable: boolean; errorKind?: string } | null = null;
  let providerUnavailable = false;
  for (let pageStart = 0; pageStart < pendingIds.length && !providerPause; pageStart += MAX_BATCH_SIZE) {
    const pageIds = pendingIds.slice(pageStart, pageStart + MAX_BATCH_SIZE).map((article) => article.id);
    const pending = await db.article.findMany({
      where: { id: { in: pageIds } },
      select: articleSelect,
      orderBy: { createdAt: 'asc' },
    });
    for (let i = 0; i < pending.length; i += concurrency) {
      assertNotAborted(signal);
      const batch = pending.slice(i, i + concurrency);
      batch.forEach((article) => attemptedIds.add(article.id));
      const results = await Promise.allSettled(batch.map(a => withTimeout(
        timeoutSignal => processWithAI(a as Article, timeoutSignal),
        AI_TIMEOUT_MS,
        `AI分析超时 "${a.title}"`,
        signal,
      )));
      assertNotAborted(signal);
      let batchErrors = 0;
      for (const [index, r] of results.entries()) {
        if (r.status === 'rejected') {
          if (isTransientBatchError(r.reason)) {
            retryablePausedIds.add(batch[index].id);
            providerPause ??= { retryable: true, errorKind: 'timeout' };
          } else {
            errors++;
            batchErrors++;
          }
          continue;
        }

        if (r.value.status === 'failed') {
          errors++;
          batchErrors++;
        } else if (r.value.status === 'deferred') {
          deferred++;
        } else {
          processed++;
        }
        if (r.value.globalError) {
          providerPause ??= {
            retryable: r.value.retryable === true,
            errorKind: r.value.errorKind,
          };
        }
      }
      if (jobId) {
        await advanceJobProgress(jobId, {
          doneDelta: batch.length,
          errorDelta: batchErrors,
          currentItemLabel: batch[batch.length - 1]?.title,
        });
      }
      if (providerPause) break;
      if (i + concurrency < pending.length) await abortableDelay(AI_DELAY_MS, signal);
    }
  }

  if (providerPause) {
    // Provider/配置级故障下，不再对剩余文章发起必然失败的 AI 请求。
    // 可恢复错误只暂缓队列，不能把未请求文章批量标失败或消耗各自重试次数。
    const remainingIds = pendingIds
      .map((article) => article.id)
      .filter((id) => !attemptedIds.has(id));
    const pausedIds = providerPause.retryable
      ? [...new Set([...remainingIds, ...retryablePausedIds])]
      : remainingIds;
    providerUnavailable = !providerPause.retryable;
    if (pausedIds.length > 0) {
      const commonWhere: Prisma.ArticleWhereInput = {
        id: { in: pausedIds },
        aiStatus: { in: ['pending', 'failed'] },
        fetchStatus: 'fetched',
        technicalIgnoredAt: null,
        eventId: null,
        clusterStatus: 'pending',
      };
      const retryDelayMs = providerPause.retryable
        ? (providerPause.errorKind === 'rate_limit' ? AI_RATE_LIMIT_RETRY_DELAY_MS : AI_PROVIDER_RETRY_DELAY_MS)
        : 30 * 60 * 1000;
      const paused = await db.article.updateMany({
        where: commonWhere,
        data: {
          aiStatus: 'pending',
          aiError: null,
          nextAiRetryAt: new Date(Date.now() + retryDelayMs),
        },
      });
      deferred += paused.count;
      if (jobId && deferred > 0) {
        await advanceJobProgress(jobId, {
          doneDelta: paused.count,
          errorDelta: 0,
          currentItemLabel: providerPause.retryable
            ? 'AI 暂时受限，队列将在冷却后自动继续'
            : 'AI 配置需要处理，未开始文章已保留',
        });
      }
    }
  }

  return {
    total,
    processed,
    errors,
    deferred,
    providerUnavailable,
    providerPaused: providerPause !== null,
  };
}
