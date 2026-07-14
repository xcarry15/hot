/**
 * 单进程写入门禁。
 *
 * SQLite 与当前部署模型只承诺一个进程，因此所有会改变流水线事实的操作
 * 共用这一份内存预约。它不是队列：发生冲突时立即拒绝，避免两个写入者
 * 各自先检查、后执行而产生竞态。
 */

export class MutationConflictError extends Error {
  readonly status = 409;

  constructor(readonly activeName: string) {
    super(`当前正在执行${activeName}，请等待完成后再操作`);
    this.name = 'MutationConflictError';
  }
}

export interface MutationReservation {
  readonly name: string;
  readonly jobType?: string;
  release(): void;
}

interface ActiveMutation {
  token: symbol;
  name: string;
  jobType?: string;
}

let activeMutation: ActiveMutation | null = null;

/** 尝试预约写入权；检查与占用之间没有异步边界。 */
export function tryReserveMutation(name: string, jobType?: string): MutationReservation | null {
  if (activeMutation) return null;

  const token = Symbol(name);
  activeMutation = { token, name, jobType };
  return {
    name,
    jobType,
    release() {
      // 仅持有者可释放，防止旧异步任务误清掉新预约。
      if (activeMutation?.token === token) activeMutation = null;
    },
  };
}

export function getActiveMutationName(): string | null {
  return activeMutation?.name ?? null;
}

/** 仅供 Job 视图/兼容调用读取；它派生自同一份预约状态。 */
export function getActiveJobType<T extends string>(): T | null {
  return (activeMutation?.jobType as T | undefined) ?? null;
}

/** 对同步写入使用同一门禁，冲突时抛出可映射为 HTTP 409 的错误。 */
export async function runExclusiveMutation<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const reservation = tryReserveMutation(name);
  if (!reservation) {
    throw new MutationConflictError(getActiveMutationName() ?? '其他写入操作');
  }

  try {
    return await fn();
  } finally {
    reservation.release();
  }
}
