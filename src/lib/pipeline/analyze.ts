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
import { refreshPublicPublications } from '@/lib/public-publication-service';

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

  const pendingWhere: Prisma.ArticleWhereInput = {
    aiStatus: { in: ['pending', 'failed'] },
    technicalIgnoredAt: null,
    eventId: { not: null },
    clusterStatus: { in: ['clustered', 'needs_review'] },
    OR: [
      { nextAiRetryAt: null },
      { nextAiRetryAt: { lte: new Date() } },
    ],
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
      tags: true,
      keyPoints: true,
      score: true,
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
  const refreshedArticleIds: string[] = [];
  // AI 并发可配置（设置项 ai_concurrency，默认 3，范围 1-10）。
  // 调高可缩短批处理时间但撞 429 风险增大；provider 故障时降低可减少无效请求。
  const rawConcurrency = parseInt(await getSetting(SETTING_KEYS.AI_CONCURRENCY) || String(DEFAULT_AI_CONCURRENCY), 10);
  const concurrency = Math.max(
    MIN_AI_CONCURRENCY,
    Math.min(MAX_AI_CONCURRENCY, Number.isFinite(rawConcurrency) ? rawConcurrency : DEFAULT_AI_CONCURRENCY),
  );

  let globalFailure = false;
  for (let pageStart = 0; pageStart < pendingIds.length && !globalFailure; pageStart += MAX_BATCH_SIZE) {
    const pageIds = pendingIds.slice(pageStart, pageStart + MAX_BATCH_SIZE).map((article) => article.id);
    const pending = await db.article.findMany({
      where: { id: { in: pageIds } },
      select: articleSelect,
      orderBy: { createdAt: 'asc' },
    });
    refreshedArticleIds.push(...pending.map((article) => article.id));
    for (let i = 0; i < pending.length; i += concurrency) {
      assertNotAborted(signal);
      const batch = pending.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(a => withTimeout(
        timeoutSignal => processWithAI(a as Article, timeoutSignal),
        AI_TIMEOUT_MS,
        `AI分析超时 "${a.title}"`,
        signal,
      )));
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
      if (globalFailure) break;
      if (i + concurrency < pending.length) await abortableDelay(AI_DELAY_MS, signal);
    }
  }

  // 统一把本批文章的持久化公开状态与最终 aiStatus/score 对齐。
  await refreshPublicPublications(refreshedArticleIds, db);
  if (globalFailure) throw new Error('AI Provider 或配置异常，剩余积压未处理');

  return { total, processed, errors };
}
