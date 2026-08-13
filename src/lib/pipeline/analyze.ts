/**
 * Pipeline / analyze 阶段应用服务。
 *
 * 单一职责：
 *   - 抓取 aiStatus ∈ {pending,failed} 且退避到期（nextAiRetryAt 已到或为空）
 *     → processWithAI 批处理
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts.analyzeAllPending`；B13 抽离后保留：
 *     · MAX_BATCH_SIZE=500、CONCURRENCY=ai_concurrency(默认1)/DELAY_MS=300、timeout=90_000
 *     · 退避 where：OR[ nextAiRetryAt=null, nextAiRetryAt <= now ]
 *     · Promise.allSettled 把 rejected 计入 errors
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { aiProcessSelect, processWithAI, toAiProcessArticle } from '@/lib/ai';
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { assertNotAborted } from '@/lib/worker-stop';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';

const AI_TIMEOUT_MS = 90_000;
const MAX_BATCH_SIZE = 100;
const DEFAULT_AI_CONCURRENCY = 1;
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
 * Batches with concurrency from settings.ai_concurrency (1-10, default 1)
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

  const pendingWhereBase: Prisma.ArticleWhereInput = {
    aiStatus: { in: ['pending', 'failed'] },
    fetchStatus: 'fetched',
    technicalIgnoredAt: null,
    eventId: null,
    clusterStatus: 'pending',
  };
  const retryWindow: Prisma.ArticleWhereInput = {
      OR: [
        { nextAiRetryAt: null },
        { nextAiRetryAt: { lte: new Date() } },
      ],
  };
  const pendingWhere: Prisma.ArticleWhereInput = {
    ...pendingWhereBase,
    ...(forceRetry ? {} : retryWindow),
  };
  const total = await db.article.count({ where: pendingWhere });
  if (jobId) await startJobStage(jobId, { stage: 'ai', total });

  let processed = 0;
  let errors = 0;
  let deferred = 0;
  // AI 并发可配置（设置项 ai_concurrency，默认 1，范围 1-10）。
  // 调高可缩短批处理时间但撞 429 风险增大；provider 故障时降低可减少无效请求。
  const rawConcurrency = parseInt(await getSetting(SETTING_KEYS.AI_CONCURRENCY) || String(DEFAULT_AI_CONCURRENCY), 10);
  const concurrency = Math.max(
    MIN_AI_CONCURRENCY,
    Math.min(MAX_AI_CONCURRENCY, Number.isFinite(rawConcurrency) ? rawConcurrency : DEFAULT_AI_CONCURRENCY),
  );

  let providerPause: { retryable: boolean; errorKind?: string; message?: string } | null = null;
  const attemptedArticleIds = new Set<string>();
  const getPendingRowsWhere = (): Prisma.ArticleWhereInput => ({
    ...pendingWhereBase,
    // forceRetry 只跳过本 Job 第一次查询的退避；当前 Job 已尝试过的文章
    // 必须等待 nextAiRetryAt，避免超时文章在同一 Job 内连续重试。
    ...(forceRetry && attemptedArticleIds.size === 0 ? {} : retryWindow),
  });
  let providerUnavailable = false;
  while (!providerPause) {
    const pendingRows = await db.article.findMany({
      where: getPendingRowsWhere(),
      select: aiProcessSelect,
      orderBy: { createdAt: 'asc' },
      take: MAX_BATCH_SIZE,
    });
    const pending = pendingRows.map(toAiProcessArticle);
    if (pending.length === 0) break;
    for (let i = 0; i < pending.length; i += concurrency) {
      assertNotAborted(signal);
      const batch = pending.slice(i, i + concurrency);
      for (const article of batch) attemptedArticleIds.add(article.id);
      const results = await Promise.allSettled(batch.map(a => withTimeout(
        timeoutSignal => processWithAI(a, timeoutSignal),
        AI_TIMEOUT_MS,
        `AI分析超时 "${a.title}"`,
        signal,
      )));
      assertNotAborted(signal);
      let batchErrors = 0;
      let unexpectedError: unknown = null;
      for (const [resultIndex, r] of results.entries()) {
        if (r.status === 'rejected') {
          if (isTransientBatchError(r.reason)) {
            // 超时/网络失败可能只影响当前文章（例如长 prompt 首 token 超时）。
            // processWithAI 已在文章级写入 failed + nextAiRetryAt；继续消费同批，
            // 不让一篇慢文章把后续新文章全部改成 AI 等待。
            errors++;
            batchErrors++;
            const article = batch[resultIndex];
            const retryCount = (article.aiRetryCount ?? 0) + 1;
            await db.article.updateMany({
              where: { id: article.id, aiStatus: { in: ['pending', 'failed'] } },
              data: retryCount >= 5
                ? {
                    aiStatus: 'skipped',
                    aiError: String(r.reason).slice(0, 1000),
                    aiRetryCount: retryCount,
                    nextAiRetryAt: null,
                    skipReason: `AI 连续失败 ${retryCount} 次，已放弃`,
                  }
                : {
                    aiStatus: 'failed',
                    aiError: String(r.reason).slice(0, 1000),
                    aiRetryCount: retryCount,
                    nextAiRetryAt: new Date(Date.now() + AI_PROVIDER_RETRY_DELAY_MS),
                  },
            });
          } else {
            errors++;
            batchErrors++;
            // processWithAI 已将可预期的文章级 AI 失败持久化为 failed。
            // 剩下的 reject 通常是数据库/程序级异常；继续 while 会反复捞到
            // 同一 pending 文章而空转，改由 Job 的有限重试统一处理。
            unexpectedError ??= r.reason;
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
            message: r.value.globalMessage,
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
      if (unexpectedError && !providerPause) throw unexpectedError;
      if (providerPause) break;
      if (i + concurrency < pending.length) await abortableDelay(AI_DELAY_MS, signal);
    }
  }

  if (providerPause) {
    // Provider/配置级故障下，不再对剩余文章发起必然失败的 AI 请求。
    // 可恢复错误只暂缓队列，不能把未请求文章批量标失败或消耗各自重试次数。
    providerUnavailable = !providerPause.retryable;
    {
      // 不再依赖开头预读的全部 ID；仅把此轮仍符合原待处理条件的文章统一延迟。
      // 已完成、已失败退避或已聚类的记录都不会被误改。
      const retryDelayMs = providerPause.retryable
        ? (providerPause.errorKind === 'rate_limit' ? AI_RATE_LIMIT_RETRY_DELAY_MS : AI_PROVIDER_RETRY_DELAY_MS)
        : 30 * 60 * 1000;
      const paused = await db.article.updateMany({
        where: {
          AND: [
            pendingWhere,
            ...(attemptedArticleIds.size > 0
              ? [{ id: { notIn: [...attemptedArticleIds] } }]
              : []),
          ],
        },
        data: {
          aiStatus: 'pending',
          // 全局配置/余额问题只保留在实际触发请求的文章上；未开始文章
          // 仅进入等待，避免把同一错误伪装成数百篇独立技术失败。
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
