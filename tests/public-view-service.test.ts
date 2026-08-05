import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventUpdate: vi.fn(),
  interactionUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    event: { update: mocks.eventUpdate },
    eventInteractionDaily: { upsert: mocks.interactionUpsert },
    $transaction: mocks.transaction,
  },
}));

import { recordPublicEventInteraction } from '@/lib/public-view-service';

describe('public-view-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventUpdate.mockResolvedValue({ id: 'e1' });
    mocks.interactionUpsert.mockResolvedValue({ eventId: 'e1' });
    mocks.transaction.mockImplementation(async (writes: Array<Promise<unknown>>) => Promise.all(writes));
  });

  it('浏览在同一事务中更新 Event 总量与上海业务日明细', async () => {
    await recordPublicEventInteraction('e1', 's1', 'view', new Date('2026-08-04T16:30:00.000Z'));

    expect(mocks.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { viewCount: { increment: 1 } },
    });
    expect(mocks.interactionUpsert).toHaveBeenCalledWith({
      where: { eventId_sourceId_dateKey: { eventId: 'e1', sourceId: 's1', dateKey: '2026-08-05' } },
      create: { eventId: 'e1', sourceId: 's1', dateKey: '2026-08-05', viewCount: 1, originalClickCount: 0 },
      update: { viewCount: { increment: 1 } },
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('原文点击只增加对应点击计数，不会借用 Article 入库日期', async () => {
    await recordPublicEventInteraction('e1', 's1', 'originalClick', new Date('2026-08-05T01:00:00.000Z'));

    expect(mocks.eventUpdate).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { originalClickCount: { increment: 1 } },
    });
    expect(mocks.interactionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ viewCount: 0, originalClickCount: 1 }),
      update: { originalClickCount: { increment: 1 } },
    }));
  });
});
