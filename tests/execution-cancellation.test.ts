import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { assertJobNotCancelled } from '@/lib/execution-cancellation';
import { JOB_CANCELLATION_POLL_INTERVAL_MS, startJobCancellationWatcher } from '@/lib/execution-lease';
import { JobLeaseLostError, runWithJobLease } from '@/lib/job-context';
import { assertWorkerCanWrite } from '@/lib/execution-write-guard';

const lease = { jobId: 'j1', owner: 'owner1' };
const isRunnerCurrent = vi.fn();
function ownedJob(status: string) {
  return { status, leaseOwner: lease.owner, leaseExpiresAt: new Date(Date.now() + 60_000) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunnerCurrent.mockResolvedValue(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('持久化 Job 取消边界', () => {
  it.each(['cancel_requested', 'cancelled'] as const)('%s 状态阻止进入下一阶段', async (status) => {
    vi.mocked(db.job.findUnique).mockResolvedValue({ status } as never);
    await expect(assertJobNotCancelled('j1')).rejects.toThrow('Job cancelled');
  });

  it('运行状态允许继续', async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({ status: 'running' } as never);
    await expect(assertJobNotCancelled('j1')).resolves.toBeUndefined();
  });

  it('Job 租约仍有效但全局执行权已丢失时，中止旧执行器', async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(ownedJob('running'));
    isRunnerCurrent.mockResolvedValue(false);
    const controller = new AbortController();
    const watcher = startJobCancellationWatcher(lease, controller, isRunnerCurrent);
    await vi.advanceTimersByTimeAsync(JOB_CANCELLATION_POLL_INTERVAL_MS);
    expect(controller.signal.reason).toBeInstanceOf(JobLeaseLostError);
    expect(vi.getTimerCount()).toBe(0);
    await expect(runWithJobLease(lease, () => assertJobNotCancelled(lease.jobId), isRunnerCurrent))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    watcher.stop();
  });

  it('等待持久化执行权检查期间收到本地取消，检查返回后仍不能写入', async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(ownedJob('running'));
    const controller = new AbortController();
    await expect(runWithJobLease(lease, async () => {
      await assertWorkerCanWrite(controller.signal);
      await db.article.update({ where: { id: 'a1' }, data: { title: 'late write' } });
    }, async () => {
      controller.abort(new Error('Stopped by user'));
      return true;
    })).rejects.toThrow('Stopped by user');
    expect(db.article.update).not.toHaveBeenCalled();
  });

  it('跨实例轮询对已取消状态中止实际执行器', async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(ownedJob('cancelled'));
    const controller = new AbortController();
    const watcher = startJobCancellationWatcher(lease, controller, isRunnerCurrent);
    await vi.advanceTimersByTimeAsync(JOB_CANCELLATION_POLL_INTERVAL_MS);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toBe('Job cancelled');
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('停止监听后，正在读取的旧取消结果不能再中止执行器', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(db.job.findUnique).mockReturnValue(new Promise((done) => { resolve = done; }) as never);
    const controller = new AbortController();
    const watcher = startJobCancellationWatcher(lease, controller, isRunnerCurrent);
    await vi.advanceTimersByTimeAsync(JOB_CANCELLATION_POLL_INTERVAL_MS);
    expect(db.job.findUnique).toHaveBeenCalledOnce();
    watcher.stop();
    resolve(ownedJob('cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    null,
    { status: 'running', leaseOwner: 'another-owner', leaseExpiresAt: new Date('2099-01-01') },
    { status: 'running', leaseOwner: lease.owner, leaseExpiresAt: new Date(0) },
  ])('租约丢失时轮询及阶段检查都阻止旧执行器继续', async (job) => {
    vi.mocked(db.job.findUnique).mockResolvedValue(job as never);
    const controller = new AbortController();
    const watcher = startJobCancellationWatcher(lease, controller, isRunnerCurrent);
    await vi.advanceTimersByTimeAsync(JOB_CANCELLATION_POLL_INTERVAL_MS);
    expect(controller.signal.reason).toBeInstanceOf(JobLeaseLostError);
    expect(vi.getTimerCount()).toBe(0);
    await expect(runWithJobLease(lease, () => assertJobNotCancelled(lease.jobId)))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    watcher.stop();
  });
});
