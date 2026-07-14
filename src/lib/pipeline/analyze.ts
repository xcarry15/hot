/**
 * Pipeline / analyze 阶段应用服务。
 *
 * 单一职责：
 *   - pre-AI dedupBeforeAI（合并 pending↔pending + pending↔done）
 *   - 抓取 aiStatus ∈ {pending,failed} 且退避到期（nextAiRetryAt 已到或为空）
 *     → processWithAI 批处理
 *   - AI 完成后对 justDone 成对互查补漏（dedupAfterAiBatch）
 *
 * 历史：
 *   - 逻辑原先内联在 `crawler.ts.analyzeAllPending`；B13 抽离后保留：
 *     · MAX_BATCH_SIZE=500、CONCURRENCY=ai_concurrency(默认3)/DELAY_MS=300、timeout=90_000
 *     · 退避 where：OR[ nextAiRetryAt=null, nextAiRetryAt <= now ]
 *     · justDone 阈值 ≥ 2 才走 batch dedup
 *     · Promise.allSettled 把 rejected 计入 errors
 */
import { db } from '@/lib/db';
import { processWithAI } from '@/lib/ai';
import { abortableDelay, withTimeout } from '@/lib/shared/async';
import { assertNotAborted } from '@/lib/worker-stop';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import {
  advanceJobProgress,
  startJobStage,
} from '@/lib/job-progress';
import { dedupBeforeAI, dedupAfterAiBatch } from '@/lib/dedup';

const AI_TIMEOUT_MS = 90_000;
const MAX_BATCH_SIZE = 500;
const DEFAULT_AI_CONCURRENCY = 3;
const MIN_AI_CONCURRENCY = 1;
const MAX_AI_CONCURRENCY = 10;
const AI_DELAY_MS = 300;

/**
 * Stage 3: Run AI for all articles with aiStatus=pending or failed.
 * Batches with concurrency from settings.ai_concurrency (1-10, default 3)
 * and 300ms delay between batches.
 */
export async function analyzeAllPending(signal?: AbortSignal, jobId?: string): Promise<{ total: number; processed: number; errors: number }> {
  assertNotAborted(signal);

  // Pre-AI dedup: compare full article bodies before AI（合并 L3 pending↔pending + P0 pending↔done）
  await dedupBeforeAI(signal);
  assertNotAborted(signal);

  const pending = await db.article.findMany({
    where: {
      aiStatus: { in: ['pending', 'failed'] },
      // 退避过滤：nextAiRetryAt 未到期的 failed 文章跳过本轮，
      // 防止 provider 故障时每轮 cron 全量重试烧 token。
      OR: [
        { nextAiRetryAt: null },
        { nextAiRetryAt: { lte: new Date() } },
      ],
    },
    select: {
      id: true,
      title: true,
      sourceId: true,
      cleanContent: true,
      articleBody: true,
      rawContent: true,
      fetchStatus: true,
      publishedAt: true,
      createdAt: true,
      summary: true,
      aiStatus: true,
      aiRetryCount: true,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_BATCH_SIZE,
  });

  if (pending.length >= MAX_BATCH_SIZE) {
    console.log(`[analyzeAllPending] batch cap reached (${MAX_BATCH_SIZE}), remaining will be picked up next tick`);
  }

  if (jobId) {
    await startJobStage(jobId, { stage: 'ai', total: pending.length });
  }

  let processed = 0;
  let errors = 0;
  // AI 并发可配置（设置项 ai_concurrency，默认 3，范围 1-10）。
  // 调高可缩短批处理时间但撞 429 风险增大；provider 故障时降低可减少无效请求。
  const rawConcurrency = parseInt(await getSetting(SETTING_KEYS.AI_CONCURRENCY) || String(DEFAULT_AI_CONCURRENCY), 10);
  const concurrency = Math.max(
    MIN_AI_CONCURRENCY,
    Math.min(MAX_AI_CONCURRENCY, Number.isFinite(rawConcurrency) ? rawConcurrency : DEFAULT_AI_CONCURRENCY),
  );

  for (let i = 0; i < pending.length; i += concurrency) {
    assertNotAborted(signal);
    const batch = pending.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(a => withTimeout(
        timeoutSignal => processWithAI(a, timeoutSignal),
        AI_TIMEOUT_MS,
        `AI分析超时 "${a.title}"`,
        signal,
      ))
    );
    let globalFailure = false;
    for (const r of results) {
      if (r.status === 'rejected' || r.value.status === 'failed') errors++;
      else processed++;
      if (r.status === 'fulfilled' && r.value.globalError) globalFailure = true;
    }
    if (jobId) {
      await advanceJobProgress(jobId, {
        doneDelta: batch.length,
        errorDelta: results.filter(r => r.status === 'rejected' || r.value.status === 'failed').length,
        currentItemLabel: batch[batch.length - 1]?.title,
      });
    }
    // 全局配置/Provider 故障：当前批次立即熔断，剩余文章保持原状态，避免逐篇烧重试次数。
    if (globalFailure) break;
    if (i + concurrency < pending.length) {
      await abortableDelay(AI_DELAY_MS, signal);
    }
  }

  // AI-batch 兜底去重：dedupAfterAI 查 DB done 候选，但同 batch 内并发完成
  // 的文章可能互相看不到对方（落库时序）→ 这里对 justDone 成对互查补漏。
  assertNotAborted(signal);
  const justDone = await db.article.findMany({
    where: { id: { in: pending.map(p => p.id) }, aiStatus: 'done' },
    select: { id: true },
  });
  if (justDone.length >= 2) {
    const batchResult = await dedupAfterAiBatch(
      justDone.map(a => a.id),
      signal,
    );
    if (batchResult.skipped > 0) {
      console.log(
        `[analyzeAllPending] AI batch dedup: checked ${batchResult.checked}, skipped ${batchResult.skipped}`
      );
    }
  }

  return { total: pending.length, processed, errors };
}
