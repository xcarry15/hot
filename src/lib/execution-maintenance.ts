import { db } from './db';
import {
  buildAiResetWhere,
  resetAiBatch,
  type AiResetAction,
} from './maintenance-service';
import { rebuildPublicPublicationSnapshotInBatches } from './public-publication-service';
import { advanceJobProgress, startJobStage } from './job-progress';
import { assertJobNotCancelled } from './execution-cancellation';
import { assertNotAborted } from './worker-stop';
import { repairDirtyEvents } from './event/event-consistency-service';

type MaintenanceJobAction = AiResetAction | 'repair-events';
const MAINTENANCE_ACTIONS = new Set<MaintenanceJobAction>(['reset-ai', 'reset-ai-failed', 'repair-events']);

function parseAction(value: unknown): MaintenanceJobAction {
  if (typeof value === 'string' && MAINTENANCE_ACTIONS.has(value as MaintenanceJobAction)) {
    return value as MaintenanceJobAction;
  }
  throw new Error('维护任务 action 无效');
}

function parseNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * 可恢复的后台维护任务：每 100 篇文章一个独立事务，并把游标写回 Job payload。
 * 进程重启或租约重试时不会重新扫描并重置整张 Article 表。
 */
export async function executeMaintenanceJob(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
): Promise<Record<string, unknown>> {
  if (!jobId) throw new Error('维护任务缺少 jobId');
  const action = parseAction(payload.action);

  if (action === 'repair-events') {
    const total = await db.eventDirty.count();
    await startJobStage(jobId, { stage: 'cluster', total, currentItemLabel: '修复待处理 Event' });
    let repaired = 0;
    while (true) {
      assertNotAborted(signal);
      await assertJobNotCancelled(jobId);
      const count = await repairDirtyEvents(undefined, signal);
      if (count === 0) break;
      repaired += count;
      await advanceJobProgress(jobId, {
        doneDelta: count,
        currentItemLabel: `已修复 ${repaired}/${total} 个 Event`,
      });
    }
    return { action, repaired, total };
  }

  let cursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
  let reset = parseNonNegativeInt(payload.reset);

  const remaining = await db.article.count({ where: buildAiResetWhere(action) });
  const total = Math.max(reset + remaining, reset);
  await startJobStage(jobId, { stage: 'ai', total, currentItemLabel: '准备重置 AI 状态' });
  if (reset > 0) await advanceJobProgress(jobId, { doneDelta: reset });

  while (true) {
    assertNotAborted(signal);
    await assertJobNotCancelled(jobId);
    const batch = await resetAiBatch(action, cursor);
    if (batch.processed === 0) break;

    reset += batch.processed;
    cursor = batch.nextCursor ?? undefined;
    await db.job.updateMany({
      where: { id: jobId, status: 'running' },
      data: {
        payload: JSON.stringify({ ...payload, action, cursor: cursor ?? null, reset, total }),
        currentItemLabel: `已重置 ${reset}/${total} 篇文章`,
      },
    });
    await advanceJobProgress(jobId, {
      doneDelta: batch.processed,
      currentItemLabel: `已重置 ${reset}/${total} 篇文章`,
    });
  }

  assertNotAborted(signal);
  await assertJobNotCancelled(jobId);
  if (reset > 0) await rebuildPublicPublicationSnapshotInBatches();
  return { action, reset, total };
}
