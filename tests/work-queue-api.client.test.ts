import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock('@/lib/request-json.client', () => ({ requestJson: mocks.requestJson }));

const summary = {
  technical: {
    total: 2,
    sources: 1,
    processFailed: 1,
    clusterFailed: 0,
    aiFailed: 1,
    pushFailed: 0,
    autoRetry: 3,
  },
  human: { total: 4, clusterReview: 2, lowConfidence: 2 },
};

async function loadClient() {
  vi.resetModules();
  return import('@/features/work-queue-api.client');
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  mocks.requestJson.mockReset();
});

describe('work queue API client', () => {
  it('合并同一时间发起的请求', async () => {
    let resolveRequest!: (value: typeof summary) => void;
    mocks.requestJson.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const client = await loadClient();

    const first = client.fetchWorkQueueSummary();
    const second = client.fetchWorkQueueSummary();

    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
    resolveRequest(summary);
    await expect(Promise.all([first, second])).resolves.toEqual([summary, summary]);
  });

  it('在 5 秒 TTL 内复用结果，过期后才重新请求', async () => {
    vi.useFakeTimers();
    mocks.requestJson.mockResolvedValue(summary);
    const client = await loadClient();

    await client.fetchWorkQueueSummary();
    await client.fetchWorkQueueSummary();
    expect(mocks.requestJson).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    await client.fetchWorkQueueSummary();
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });

  it('把连续失效合并为一次尾部刷新，并通知订阅者', async () => {
    vi.useFakeTimers();
    const nextSummary = { ...summary, human: { total: 3, clusterReview: 1, lowConfidence: 2 } };
    mocks.requestJson.mockResolvedValueOnce(summary).mockResolvedValueOnce(nextSummary);
    const client = await loadClient();
    const listener = vi.fn();
    client.subscribeToWorkQueueSummary(listener);

    await client.fetchWorkQueueSummary();
    client.scheduleWorkQueueSummaryRefresh();
    await client.fetchWorkQueueSummary();
    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    client.scheduleWorkQueueSummaryRefresh();
    expect(mocks.requestJson).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.requestJson).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(nextSummary);
  });

  it('失效发生在旧请求返回前时，不发布旧摘要', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: typeof summary) => void;
    const nextSummary = { ...summary, human: { total: 3, clusterReview: 1, lowConfidence: 2 } };
    mocks.requestJson
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(nextSummary);
    const client = await loadClient();
    const listener = vi.fn();
    client.subscribeToWorkQueueSummary(listener);

    const first = client.fetchWorkQueueSummary();
    client.scheduleWorkQueueSummaryRefresh();
    resolveFirst(summary);
    await first;
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(nextSummary));
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });
});
