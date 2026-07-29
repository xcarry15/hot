import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventUpdateMany: vi.fn(),
  webhookConfigs: vi.fn(),
  targetStates: vi.fn(),
  pushEvent: vi.fn(),
  pushableWhere: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    event: {
      findMany: mocks.eventFindMany,
      updateMany: mocks.eventUpdateMany,
    },
  },
}));

vi.mock('@/lib/settings', () => ({
  getWebhookConfigs: mocks.webhookConfigs,
}));

vi.mock('@/lib/push/policy', () => ({
  PUSH_MAX_RETRIES: 5,
  pushableWhere: mocks.pushableWhere,
  readPushSettings: vi.fn(),
}));

vi.mock('@/lib/push/delivery', () => ({
  getPushTargetStatesForEvents: mocks.targetStates,
  pushEventToFeishu: mocks.pushEvent,
}));

import { pushAllUnpushed } from '@/lib/push/batch';

const settings = { pushMode: 'batch' as const, minScore: 80, minRelevance: 70 };

function event(id: string, score = 80) {
  return { id, representativeArticle: { score } };
}

function noTargetState(ids: string[]) {
  return new Map(ids.map((id) => [id, [{ latestStatus: 'never_attempted' }]]));
}

describe('pushAllUnpushed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.webhookConfigs.mockResolvedValue([{ url: 'https://hook.example/a', remark: 'A', enabled: true }]);
    mocks.eventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.pushableWhere.mockReturnValue({ pushedAt: null });
    mocks.targetStates.mockImplementation(async (ids: string[]) => noTargetState(ids));
    mocks.pushEvent.mockResolvedValue({ status: 'completed' });
  });

  it('使用固定窗口持续清空积压，而不是一次载入全部 Event', async () => {
    mocks.eventFindMany
      .mockResolvedValueOnce([event('e1', 80), event('e2', 95)])
      .mockResolvedValueOnce([event('e3', 90)])
      .mockResolvedValueOnce([]);

    await expect(pushAllUnpushed(undefined, settings)).resolves.toEqual({
      success: 3,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.eventFindMany).toHaveBeenCalledTimes(3);
    expect(mocks.eventFindMany.mock.calls.every(([query]) => query.take === 100)).toBe(true);
    expect(mocks.pushEvent).toHaveBeenCalledTimes(3);
    expect(mocks.pushEvent.mock.calls.map(([eventId]) => eventId)).toEqual(['e2', 'e1', 'e3']);
  });

  it('结果未知的 Event 收口为人工处理，不会在后续窗口中反复被自动捞取', async () => {
    mocks.eventFindMany
      .mockResolvedValueOnce([event('unknown')])
      .mockResolvedValueOnce([]);
    mocks.targetStates.mockResolvedValue(new Map([
      ['unknown', [{ latestStatus: 'unknown' }]],
    ]));

    await expect(pushAllUnpushed(undefined, settings)).resolves.toEqual({
      success: 0,
      failed: 0,
      skipped: 1,
    });

    expect(mocks.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['unknown'] }, pushRetryCount: { lt: 5 } },
      data: { pushRetryCount: 5, nextPushRetryAt: null },
    });
    expect(mocks.pushEvent).not.toHaveBeenCalled();
    expect(mocks.eventFindMany).toHaveBeenCalledTimes(2);
  });

  it('推送调用出现未收口异常时交给 Job 重试，避免 while 重复处理同一 Event', async () => {
    mocks.eventFindMany.mockResolvedValue([event('broken')]);
    mocks.pushEvent.mockRejectedValue(new Error('database unavailable'));

    await expect(pushAllUnpushed(undefined, settings)).rejects.toThrow('database unavailable');
    expect(mocks.eventFindMany).toHaveBeenCalledTimes(1);
  });
});
