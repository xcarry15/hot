/**
 * 重构 #4：job-progress.ts 单元测试。
 *
 * 重点覆盖：
 * - advanceJobProgress 不修改非 running Job
 * - 进度不允许超过 total（total=0 的不确定进度除外）
 * - heartbeat 30 秒定时器在 Job 已 completed 时是 no-op
 * - Job 表是唯一进度事实源，不依赖额外事件通道
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock runWithJobId / getCurrentJobId 走直传
vi.mock('@/lib/job-context', () => ({
  runWithJobId: <T>(_id: string, fn: () => Promise<T>) => fn(),
  getCurrentJobId: () => 'job-test',
}));

// Mock db.job
const updateManyMock = vi.fn();
const updateMock = vi.fn();
const findUniqueMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    job: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

import {
  startJobStage,
  advanceJobProgress,
  touchJobHeartbeat,
  startJobHeartbeat,
  stopJobHeartbeat,
  markJobCompleted,
  markJobFailed,
} from '@/lib/job-progress';

describe('startJobStage', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
  });

  it('设置 currentStage + 重置 done/errors=0 + 写 heartbeatAt', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await startJobStage('job-1', { stage: 'collect', total: 5 });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running' },
      data: expect.objectContaining({
        currentStage: 'collect',
        progressTotal: 5,
        progressDone: 0,
        progressErrors: 0,
        heartbeatAt: expect.any(Date),
      }),
    });
  });

  it('total 接受 0（未知进度场景）', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await startJobStage('job-2', { stage: 'process', total: 0 });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-2', status: 'running' },
      data: expect.objectContaining({ progressTotal: 0 }),
    });
  });
});

describe('advanceJobProgress', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    findUniqueMock.mockReset();
  });

  it('doneDelta + errorDelta 累加', async () => {
    findUniqueMock.mockResolvedValueOnce({
      progressTotal: 10,
      progressDone: 2,
      progressErrors: 1,
      status: 'running',
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await advanceJobProgress('job-3', { doneDelta: 3, errorDelta: 1 });

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-3', status: 'running' },
      data: expect.objectContaining({
        progressDone: 5, // 2 + 3
        progressErrors: 2, // 1 + 1
        heartbeatAt: expect.any(Date),
      }),
    });
  });

  it('进度不允许超过 total（total=10 时 8+5 → 10）', async () => {
    findUniqueMock.mockResolvedValueOnce({
      progressTotal: 10,
      progressDone: 8,
      progressErrors: 0,
      status: 'running',
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await advanceJobProgress('job-cap', { doneDelta: 5 });

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-cap', status: 'running' },
      data: expect.objectContaining({ progressDone: 10 }),
    });
  });

  it('total=0 时不确定进度：done 累加不被上限封顶', async () => {
    findUniqueMock.mockResolvedValueOnce({
      progressTotal: 0,
      progressDone: 100,
      progressErrors: 0,
      status: 'running',
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await advanceJobProgress('job-indet', { doneDelta: 50 });

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-indet', status: 'running' },
      data: expect.objectContaining({ progressDone: 150 }),
    });
  });

  it('Job 非 running 时跳过更新', async () => {
    findUniqueMock.mockResolvedValueOnce({
      progressTotal: 5,
      progressDone: 0,
      progressErrors: 0,
      status: 'completed',
    });

    await advanceJobProgress('job-done', { doneDelta: 1 });

    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('doneDelta=0 + errorDelta=0 + 无 itemLabel → 不写库', async () => {
    await advanceJobProgress('job-noop', {});
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe('touchJobHeartbeat', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
  });

  it('只写 heartbeatAt', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await touchJobHeartbeat('job-hb');
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-hb', status: 'running' },
      data: { heartbeatAt: expect.any(Date) },
    });
  });
});

describe('heartbeat timer', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('30 秒间隔刷新 heartbeatAt，stopJobHeartbeat 清理', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    const t = startJobHeartbeat('job-timer', 30_000);
    expect(updateManyMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateManyMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateManyMock).toHaveBeenCalledTimes(2);

    stopJobHeartbeat(t);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(updateManyMock).toHaveBeenCalledTimes(2); // 清理后无新调用
  });

  it('stopJobHeartbeat(null) 不抛错', () => {
    expect(() => stopJobHeartbeat(null)).not.toThrow();
  });
});

describe('markJobCompleted / markJobFailed', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
  });

  it('markJobCompleted 写 completed + result + completedAt + heartbeatAt', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await markJobCompleted('job-comp', { ok: true });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-comp', status: 'running' },
      data: expect.objectContaining({
        status: 'completed',
        result: JSON.stringify({ ok: true }),
        completedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      }),
    });
  });

  it('markJobFailed 写 failed + error + completedAt', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await markJobFailed('job-fail', 'something broke');
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-fail', status: 'running' },
      data: expect.objectContaining({
        status: 'failed',
        error: 'something broke',
        completedAt: expect.any(Date),
      }),
    });
  });

  it('markJobFailed 截断 error 到 2000 字符', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    const long = 'x'.repeat(5000);
    await markJobFailed('job-long', long);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'job-long', status: 'running' },
      data: expect.objectContaining({
        error: 'x'.repeat(2000),
      }),
    });
  });
});
