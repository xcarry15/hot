import { reprocessWithAI } from './ai';
import { refetchArticle } from './article-refetch-service';
import { db } from './db';
import { LOW_ANALYSIS_CONFIDENCE_FILTER } from '@/contracts/ai-confidence';
import { clusterArticle, markClusterFailure } from './event-clustering-service';
import { recalculateEventById } from './event-service';
import { assertJobNotCancelled } from './execution-cancellation';
import type { SingleWorkflowIntent, SingleWorkflowStart } from './execution-types';
import { startJobStage, advanceJobProgress } from './job-progress';
import { runStages } from './pipeline/stage-runner';
import { getFailedPushTargets, pushArticleToFeishu } from './push/delivery';

export async function validateSingleArticleWorkflow(
  articleId: string,
  startAt: SingleWorkflowStart,
  intent: SingleWorkflowIntent,
): Promise<{ ok: true } | { ok: false; status: 404 | 409; reason: string }> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: { fetchStatus: true, clusterStatus: true, aiStatus: true, skipReason: true, eventId: true, event: { select: { nextPushRetryAt: true, pushRetryCount: true } } },
  });
  if (!article) return { ok: false, status: 404, reason: '文章不存在' };
  if (intent === 'regenerate') {
    if (startAt === 'push') return { ok: false, status: 409, reason: '完整重新推送请使用 Event 人工推送' };
    return { ok: true };
  }
  if (startAt === 'process' && article.fetchStatus !== 'failed') {
    return { ok: false, status: 409, reason: '正文处理未失败，不能执行技术重试' };
  }
  if (startAt === 'cluster' && article.clusterStatus !== 'failed') {
    return { ok: false, status: 409, reason: '聚类未失败，不能执行技术重试' };
  }
  if (startAt === 'ai' && article.aiStatus !== 'failed' && !(article.aiStatus === 'skipped' && article.skipReason?.startsWith('AI 连续失败'))) {
    return { ok: false, status: 409, reason: 'AI 当前不是可恢复失败，不能执行技术重试' };
  }
  if (startAt === 'push') {
    if (!article.eventId) return { ok: false, status: 409, reason: '文章尚未归属 Event，不能重试推送' };
    if ((await getFailedPushTargets(article.eventId)).length === 0) {
      return { ok: false, status: 409, reason: '当前没有失败的推送目标' };
    }
    if (article.event?.nextPushRetryAt && article.event.nextPushRetryAt > new Date()) {
      return { ok: false, status: 409, reason: `推送重试等待中，可重试时间: ${article.event.nextPushRetryAt.toISOString()}` };
    }
  }
  return { ok: true };
}

/**
 * 校验低分析置信队列的批量 AI 重跑。
 *
 * 只允许队列当下仍是“AI 已完成且置信度低”的文章，避免管理员打开列表后
 * 文章状态已变化，却误把其它文章重新清空事件并送入 AI。
 */
export async function validateBatchArticleRegeneration(
  articleIds: string[],
): Promise<{ ok: true; articleIds: string[] } | { ok: false; status: 400 | 409; reason: string }> {
  const ids = [...new Set(articleIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, status: 400, reason: '至少选择一篇文章' };
  if (ids.length > 100) return { ok: false, status: 400, reason: '单次最多重跑 100 篇文章' };

  const eligibleCount = await db.article.count({
    where: {
      id: { in: ids },
      ...LOW_ANALYSIS_CONFIDENCE_FILTER,
    },
  });
  if (eligibleCount !== ids.length) {
    return { ok: false, status: 409, reason: '部分文章已不属于低分析置信队列，请刷新后重试' };
  }
  return { ok: true, articleIds: ids };
}

export function isSingleWorkflow(payload: Record<string, unknown>): boolean {
  return payload.scope === 'single' && payload.workflow === true && typeof payload.articleId === 'string';
}

export async function executeSingleArticleWorkflow(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  const articleId = payload.articleId as string;
  const startAt = payload.startAt as SingleWorkflowStart;
  const intent = payload.intent as SingleWorkflowIntent;
  const valid: readonly SingleWorkflowStart[] = ['process', 'cluster', 'ai', 'push'];
  if (!valid.includes(startAt)) throw new Error('Invalid single article workflow start stage');
  const article = await db.article.findUnique({ where: { id: articleId }, select: { id: true, title: true, eventId: true } });
  if (!article) throw new Error('Article not found');
  if (intent !== 'retry' && intent !== 'regenerate') throw new Error('Invalid single article workflow intent');
  await db.article.update({ where: { id: articleId }, data: { technicalIgnoredAt: null } });
  let aiResult: Awaited<ReturnType<typeof reprocessWithAI>> | undefined;
  const stageResults = await runStages([
    {
      key: 'process',
      shouldRun: () => startAt === 'process',
      run: async () => {
        if (jobId) await startJobStage(jobId, { stage: 'process', total: 1, currentItemLabel: article.title });
        const processResult = await refetchArticle(articleId);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        if (!processResult || processResult.success !== true) {
          const reason = processResult?.error || '未获取到有效正文';
          throw new Error(`正文重新获取失败：${reason}；已停止后续 AI 分析和事件聚类`);
        }
        return processResult;
      },
    },
    {
      key: 'ai',
      shouldRun: () => startAt === 'process' || startAt === 'ai',
      run: async () => {
        if (startAt === 'ai') await prepareArticleForAiRegeneration(articleId);
        aiResult = await reprocessWithAI(articleId, signal, jobId);
        return aiResult;
      },
    },
    {
      key: 'cluster',
      shouldRun: () => startAt === 'cluster' || aiResult?.status === 'done',
      run: async () => {
        await db.article.update({
          where: { id: articleId },
          data: {
            ...(intent === 'regenerate' ? { eventId: null } : {}),
            clusterStatus: 'pending',
            clusteredAt: null,
            clusterError: null,
            clusterRetryCount: 0,
            nextClusterRetryAt: null,
          },
        });
        if (intent === 'regenerate' && article.eventId) await recalculateEventById(article.eventId);
        if (jobId) await startJobStage(jobId, { stage: 'cluster', total: 1, currentItemLabel: article.title });
        const clusterResult = await clusterSingleArticle(articleId, signal);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        return clusterResult;
      },
    },
    {
      key: 'push',
      shouldRun: () => startAt === 'push',
      run: async () => {
        if (jobId) await startJobStage(jobId, { stage: 'push', total: 1, currentItemLabel: article.title });
        if (article.eventId) {
          await db.event.update({ where: { id: article.eventId }, data: { pushRetryCount: 0, nextPushRetryAt: null } });
        }
        const pushResult = await pushArticleToFeishu(articleId, 'retry_failed', signal);
        if (jobId) await advanceJobProgress(jobId, { doneDelta: 1, currentItemLabel: article.title });
        return pushResult;
      },
    },
  ], {
    signal,
    beforeStage: async () => {
      if (jobId) await assertJobNotCancelled(jobId);
    },
  });
  return { articleId, startAt, intent, stages: Object.keys(stageResults), ...stageResults };
}

export async function prepareArticleForAiRegeneration(articleId: string): Promise<void> {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { eventId: true } });
  if (!article) return;
  await db.article.update({
    where: { id: articleId },
    data: {
      eventId: null,
      clusterStatus: 'pending',
      clusteredAt: null,
      clusterError: null,
      clusterRetryCount: 0,
      nextClusterRetryAt: null,
    },
  });
  if (article.eventId) await recalculateEventById(article.eventId);
}

export async function clusterSingleArticle(articleId: string, signal?: AbortSignal) {
  try {
    return await clusterArticle(articleId, signal);
  } catch (error) {
    await markClusterFailure(articleId, error);
    throw error;
  }
}
