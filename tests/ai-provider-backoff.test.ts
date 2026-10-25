import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    aiProviderState: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
    },
  },
}));

import {
  AI_PROVIDER_MAX_BACKOFF_MS,
  AI_PROVIDER_RETRY_DELAY_MS,
  AI_RATE_LIMIT_RETRY_DELAY_MS,
  clearAIProviderBackoff,
  getAIProviderBackoff,
  noteAIProviderFailure,
} from '@/lib/ai-provider-backoff';

describe('AI Provider 持久化冷却与退避', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    mocks.upsert.mockImplementation(async (args: { create: Record<string, unknown> }) => args.create);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('首次 429 使用统一限流退避，并保留 Retry-After 较长值', async () => {
    mocks.findUnique.mockResolvedValue(null);

    const state = await noteAIProviderFailure('openrouter', {
      kind: 'rate_limit',
      status: 429,
      retryAfterMs: 10 * 60 * 1000,
    });

    expect(state.failureCount).toBe(1);
    expect(state.lastErrorKind).toBe('rate_limit');
    expect(state.lastStatus).toBe(429);
    expect(state.cooldownUntil).toEqual(new Date('2026-09-01T00:10:00.000Z'));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'openrouter' },
      create: expect.objectContaining({
        lastRetryAfterMs: 10 * 60 * 1000,
      }),
    }));
  });

  it('连续 Provider 故障按次数指数退避，并限制最大冷却', async () => {
    mocks.findUnique.mockResolvedValue({
      provider: 'deepseek',
      cooldownUntil: new Date('2026-09-01T00:02:00.000Z'),
      failureCount: 1,
      lastErrorKind: 'provider',
      lastStatus: 503,
      lastRetryAfterMs: null,
    });

    const state = await noteAIProviderFailure('deepseek', { kind: 'provider', status: 503 });

    expect(state.failureCount).toBe(2);
    expect(state.cooldownUntil).toEqual(new Date('2026-09-01T00:04:00.000Z'));
    expect(AI_PROVIDER_RETRY_DELAY_MS).toBe(2 * 60 * 1000);
    expect(AI_RATE_LIMIT_RETRY_DELAY_MS).toBe(5 * 60 * 1000);
    expect(AI_PROVIDER_MAX_BACKOFF_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('读取 Provider 状态，并且清理查询只覆盖已到期的冷却', async () => {
    const row = {
      provider: 'deepseek',
      cooldownUntil: new Date('2026-09-01T00:01:00.000Z'),
      failureCount: 1,
      lastErrorKind: 'rate_limit',
      lastStatus: 429,
      lastRetryAfterMs: 60_000,
    };
    mocks.findUnique.mockResolvedValue(row);

    await expect(getAIProviderBackoff('deepseek')).resolves.toEqual(row);
    await clearAIProviderBackoff('deepseek');

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'deepseek',
        failureCount: { gt: 0 },
        OR: [
          { cooldownUntil: null },
          { cooldownUntil: { lte: new Date('2026-09-01T00:00:00.000Z') } },
        ],
      },
      data: {
        cooldownUntil: null,
        failureCount: 0,
        lastErrorKind: '',
        lastStatus: null,
        lastRetryAfterMs: null,
      },
    });
  });
});
