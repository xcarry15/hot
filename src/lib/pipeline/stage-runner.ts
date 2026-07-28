import { assertNotAborted } from '@/lib/worker-stop';

export interface PipelineStageTask {
  key: string;
  run: () => Promise<unknown>;
  /** 条件不满足时跳过阶段，不写入结果，也不伪造进度。 */
  shouldRun?: () => boolean;
  /** 只有明确声明的阶段才允许在失败后执行补偿动作。 */
  onError?: (error: unknown) => Promise<void>;
}

export interface RunStagesOptions {
  signal?: AbortSignal;
  beforeStage?: () => Promise<void>;
}

/**
 * 固定流水线的小型阶段执行器。
 *
 * 它只收敛取消检查、阶段顺序和显式错误策略；阶段自身仍负责查询、
 * 持久化和 Job 进度，避免演化成隐藏业务规则的通用工作流引擎。
 */
export async function runStages(
  tasks: readonly PipelineStageTask[],
  options: RunStagesOptions = {},
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const task of tasks) {
    if (task.shouldRun && !task.shouldRun()) continue;
    assertNotAborted(options.signal);
    await options.beforeStage?.();
    try {
      results[task.key] = await task.run();
    } catch (error) {
      if (task.onError) {
        try {
          await task.onError(error);
        } catch (compensationError) {
          // 补偿失败不能掩盖原阶段失败；Job 的有限重试应围绕最初的故障原因。
          console.error(`[stage-runner] compensation failed after ${task.key}:`, compensationError);
        }
      }
      throw error;
    }
  }
  return results;
}
