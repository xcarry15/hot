import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-helpers';
import { abortRunningJob } from '@/lib/execution';

/**
 * POST /api/worker/stop
 *
 * 请求停止当前正在执行的后台任务。
 *   - abort 当前 job 的 AbortController（进程内立即生效）
 *   - 把所有处于 running 状态的 Job 记录标记为 failed（清理孤儿）
 */
export async function POST() {
  try {
    const { resetCount } = await abortRunningJob();
    return NextResponse.json({ stopped: true, resetCount });
  } catch (error: unknown) {
    return apiError(error, 'Failed to stop worker');
  }
}
