import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobCreate: vi.fn(),
  jobFindFirst: vi.fn(),
  jobFindMany: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdate: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobDeleteMany: vi.fn(),
  sourceFindUnique: vi.fn(),
  markJobCompleted: vi.fn(),
  markJobFailed: vi.fn(),
  markJobCancelled: vi.fn(),
  collectAllSources: vi.fn(),
  crawlSource: vi.fn(),
  pushAllPendingArticles: vi.fn(),
  acquireJobRunnerLease: vi.fn(),
  clearExpiredJobRunnerLease: vi.fn(),
  runnerLeaseRenew: vi.fn(),
  runnerLeaseRelease: vi.fn(),
  normalizeAiRecoveryBacklog: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    job: {
      create: mocks.jobCreate,
      findFirst: mocks.jobFindFirst,
      findMany: mocks.jobFindMany,
      findUnique: mocks.jobFindUnique,
      update: mocks.jobUpdate,
      updateMany: mocks.jobUpdateMany,
      deleteMany: mocks.jobDeleteMany,
    },
    source: {
      findUnique: mocks.sourceFindUnique,
    },
  },
}));

vi.mock('@/lib/pipeline/collect', () => ({
  collectAllSources: mocks.collectAllSources,
  crawlSource: mocks.crawlSource,
}));
vi.mock('@/lib/pipeline/process', () => ({ processAllPending: vi.fn() }));
vi.mock('@/lib/pipeline/analyze', () => ({ analyzeAllPending: vi.fn() }));
vi.mock('@/lib/pipeline/ai-recovery', () => ({ normalizeAiRecoveryBacklog: mocks.normalizeAiRecoveryBacklog }));
vi.mock('@/lib/pipeline/push-bridge', () => ({ pushAllPendingArticles: mocks.pushAllPendingArticles }));
vi.mock('@/lib/push/policy', () => ({ shouldPushAtPipelineEnd: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/job-runner-lease', () => ({
  acquireJobRunnerLease: mocks.acquireJobRunnerLease,
  clearExpiredJobRunnerLease: mocks.clearExpiredJobRunnerLease,
}));
vi.mock('@/lib/job-progress', () => ({
  markJobCompleted: mocks.markJobCompleted,
  markJobFailed: mocks.markJobFailed,
  markJobCancelled: mocks.markJobCancelled,
  startJobHeartbeat: vi.fn(() => null),
  stopJobHeartbeat: vi.fn(),
  startJobStage: vi.fn().mockResolvedValue(undefined),
  advanceJobProgress: vi.fn().mockResolvedValue(undefined),
}));

import { abortRunningJob, computeIdempotencyKey, resetOrphanedJobs, resumeQueuedJob, runJob } from '@/lib/execution';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
}

describe.sequential('global job execution invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobFindFirst.mockReset().mockResolvedValue(null);
    mocks.jobFindMany.mockReset().mockResolvedValue([]);
    mocks.jobFindUnique.mockReset().mockResolvedValue(null);
    mocks.jobUpdateMany.mockReset().mockResolvedValue({ count: 1 }); // needed for claimAndRunJob
    mocks.jobDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.acquireJobRunnerLease.mockResolvedValue({
      renew: mocks.runnerLeaseRenew.mockResolvedValue(true),
      release: mocks.runnerLeaseRelease.mockResolvedValue(undefined),
    });
    mocks.clearExpiredJobRunnerLease.mockResolvedValue(undefined);
    mocks.normalizeAiRecoveryBacklog.mockResolvedValue(0);
  });

  it('为自动重试任务按 Job 类型生成不同幂等键', () => {
    const fullKey = computeIdempotencyKey('full', { trigger: 'auto_retry' });
    const clusterKey = computeIdempotencyKey('cluster', { trigger: 'auto_retry' });

    expect(fullKey).toMatch(/^technical-retry:full:/);
    expect(clusterKey).toMatch(/^technical-retry:cluster:/);
    expect(fullKey).not.toBe(clusterKey);
  });

  it('persists a stop request when the executor is in another module instance', async () => {
    const stopped = await abortRunningJob();

    expect(stopped).toEqual({ resetCount: 0 });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { status: 'running' },
      data: {
        status: 'cancel_requested',
        cancelRequestedAt: expect.any(Date),
      },
    });
  });

  it('rejects every overlapping job type and releases the reservation after completion', async () => {
    const running = deferred<{ results: never[]; totalNewArticles: number; errors: number }>();
    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce({ id: 'job-2' });
    mocks.markJobCompleted.mockResolvedValue(undefined);
    mocks.markJobFailed.mockResolvedValue(undefined);
    mocks.collectAllSources.mockReturnValueOnce(running.promise);
    mocks.pushAllPendingArticles.mockResolvedValue({ total: 0, processed: 0, errors: 0 });

    await expect(runJob('collect')).resolves.toEqual({ queued: true, jobId: 'job-1' });
    await expect(runJob('push')).resolves.toEqual({ queued: false, reason: 'collect job already active' });
    expect(mocks.jobCreate).toHaveBeenCalledTimes(1);

    running.resolve({ results: [], totalNewArticles: 0, errors: 0 });
    await waitFor(() => mocks.markJobCompleted.mock.calls.some(call => call[0] === 'job-1'));

    await expect(runJob('push')).resolves.toEqual({ queued: true, jobId: 'job-2' });
    await waitFor(() => mocks.markJobCompleted.mock.calls.filter(call => call[0] === 'job-2').length === 1);
  });

  it('releases the reservation when Job creation fails', async () => {
    mocks.jobFindFirst.mockResolvedValue(null);
    mocks.jobCreate.mockRejectedValueOnce(new Error('sqlite unavailable'));
    await expect(runJob('collect')).rejects.toThrow('sqlite unavailable');

    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-after-failure' });
    mocks.pushAllPendingArticles.mockResolvedValue({ total: 0, processed: 0, errors: 0 });
    await expect(runJob('push')).resolves.toEqual({ queued: true, jobId: 'job-after-failure' });
    await waitFor(() => mocks.markJobCompleted.mock.calls.some(call => call[0] === 'job-after-failure'));
  });

  it('领取新建 Job 失败时删除队列记录，避免后续调度器误执行', async () => {
    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-unclaimed' });
    mocks.jobUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(runJob('collect')).resolves.toEqual({
      queued: false,
      reason: 'failed to claim queued job',
    });

    expect(mocks.jobDeleteMany).toHaveBeenCalledWith({
      where: { id: 'job-unclaimed', status: 'queued', attempt: 0 },
    });
  });

  it('requests cooperative cancellation without racing the pipeline status update', async () => {
    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-stop' });
    mocks.collectAllSources.mockImplementationOnce((_signal?: AbortSignal) => {
      // execution passes signal as the first argument to collectAllSources.
      const signal = _signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    await runJob('collect');
    const stopped = await abortRunningJob();

    expect(stopped).toEqual({ resetCount: 0 });
    await waitFor(() => mocks.markJobCancelled.mock.calls.some(call =>
      call[0] === 'job-stop' && call[1] === 'Stopped by user',
    ));
  });

  it('keeps the single-source collect result shape while persisting its job progress', async () => {
    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-source' });
    mocks.sourceFindUnique.mockResolvedValueOnce({ name: 'source-1' });
    mocks.crawlSource.mockResolvedValueOnce({
      success: true,
      items: [{ title: 'article', url: 'https://example.com/article' }],
    });

    await expect(runJob('collect', { sourceId: 'src-1' })).resolves.toEqual({
      queued: true,
      jobId: 'job-source',
    });
    await waitFor(() => mocks.markJobCompleted.mock.calls.some(call => call[0] === 'job-source'));

    const [, result] = mocks.markJobCompleted.mock.calls.find(call => call[0] === 'job-source')!;
    expect(result).toEqual({
      sourceId: 'src-1',
      result: { success: true, itemsFound: 1, newArticles: 0, error: undefined },
    });
  });

  it('requeues a crashed batch job instead of marking it terminal on the first attempt', async () => {
    mocks.jobCreate.mockResolvedValueOnce({ id: 'job-retry' });
    mocks.collectAllSources.mockRejectedValueOnce(new Error('sqlite busy'));
    mocks.jobFindUnique.mockResolvedValueOnce({ status: 'running', attempt: 1, maxAttempts: 3 });

    await expect(runJob('collect')).resolves.toEqual({ queued: true, jobId: 'job-retry' });

    await waitFor(() => mocks.jobUpdateMany.mock.calls.some(([input]) => input?.data?.status === 'queued'));
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-retry', status: 'running', attempt: 1 },
      data: expect.objectContaining({ status: 'queued', availableAt: expect.any(Date) }),
    }));
    expect(mocks.markJobFailed).not.toHaveBeenCalledWith('job-retry', expect.anything());
  });

  it('resumes a ready queued job with its persisted payload', async () => {
    mocks.jobFindFirst.mockResolvedValueOnce({
      id: 'queued-push',
      type: 'push',
      payload: JSON.stringify({ trigger: 'recovery' }),
    });
    mocks.pushAllPendingArticles.mockResolvedValueOnce({ total: 0, processed: 0, errors: 0 });

    await expect(resumeQueuedJob()).resolves.toEqual({ queued: true, jobId: 'queued-push' });
    await waitFor(() => mocks.markJobCompleted.mock.calls.some(call => call[0] === 'queued-push'));
  });

  it('requeues an expired running job while attempts remain', async () => {
    mocks.jobFindMany.mockResolvedValueOnce([
      { id: 'orphan-1', status: 'running', attempt: 1, maxAttempts: 3 },
    ]);

    await expect(resetOrphanedJobs()).resolves.toEqual({ requeued: 1, failed: 0, cancelled: 0 });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'orphan-1', status: 'running', attempt: 1 }),
      data: expect.objectContaining({ status: 'queued', availableAt: expect.any(Date) }),
    }));
  });
});
