import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobCreate: vi.fn(),
  jobFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  jobUpdateMany: vi.fn(),
  sourceFindUnique: vi.fn(),
  markJobCompleted: vi.fn(),
  markJobFailed: vi.fn(),
  markJobCancelled: vi.fn(),
  collectAllSources: vi.fn(),
  crawlSource: vi.fn(),
  pushAllPendingArticles: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    job: {
      create: mocks.jobCreate,
      findFirst: mocks.jobFindFirst,
      findUnique: vi.fn(),
      update: mocks.jobUpdate,
      updateMany: mocks.jobUpdateMany,
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
vi.mock('@/lib/pipeline/push-bridge', () => ({ pushAllPendingArticles: mocks.pushAllPendingArticles }));
vi.mock('@/lib/push/policy', () => ({ shouldPushAtPipelineEnd: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/job-progress', () => ({
  markJobCompleted: mocks.markJobCompleted,
  markJobFailed: mocks.markJobFailed,
  markJobCancelled: mocks.markJobCancelled,
  startJobHeartbeat: vi.fn(() => null),
  stopJobHeartbeat: vi.fn(),
  startJobStage: vi.fn().mockResolvedValue(undefined),
  advanceJobProgress: vi.fn().mockResolvedValue(undefined),
}));

import { abortRunningJob, runJob } from '@/lib/execution';

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
    mocks.jobFindFirst.mockReset().mockResolvedValue(null);
    mocks.jobUpdateMany.mockReset().mockResolvedValue({ count: 1 }); // needed for claimAndRunJob
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
      result: { success: true, itemsFound: 1, error: undefined },
    });
  });
});
