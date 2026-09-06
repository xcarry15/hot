import { describe, expect, it } from 'vitest';
import { buildAiRecoveryWhere, buildAiResetWhere } from '@/lib/ai-queue-policy';

describe('AI queue policy', () => {
  it('自动恢复只选择已到期且存在 Event/聚类残留的组合', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    expect(buildAiRecoveryWhere(false, now)).toMatchObject({
      fetchStatus: 'fetched',
      technicalIgnoredAt: null,
      AND: [
        expect.objectContaining({ OR: [{ eventId: { not: null } }, { clusterStatus: { not: 'pending' } }] }),
        expect.objectContaining({
          OR: [
            { aiStatus: 'failed', nextAiRetryAt: { lte: now } },
            { aiStatus: 'pending', nextAiRetryAt: { lte: now } },
          ],
        }),
      ],
    });
  });

  it('人工重置覆盖失败和连续失败跳过项，但不把待处理项重复纳入', () => {
    expect(buildAiResetWhere('reset-ai-failed')).toEqual({
      OR: [
        { aiStatus: 'failed' },
        { aiStatus: 'skipped', skipReason: { startsWith: 'AI 连续失败' } },
      ],
    });
    expect(buildAiResetWhere('reset-ai')).toEqual({ aiStatus: { not: 'pending' } });
  });
});
