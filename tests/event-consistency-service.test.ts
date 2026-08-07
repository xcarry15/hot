import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { markEventDirty, repairDirtyEvents } from '@/lib/event/event-consistency-service';

describe('Event 脏标记', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同一 Event 以唯一键覆盖标记，避免恢复队列重复膨胀', async () => {
    await markEventDirty('event-1', 'x'.repeat(600));

    expect(db.eventDirty.upsert).toHaveBeenCalledTimes(1);
    expect(db.eventDirty.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: 'event-1' },
      create: expect.objectContaining({ eventId: 'event-1', reason: 'x'.repeat(500) }),
      update: expect.objectContaining({ reason: 'x'.repeat(500) }),
    }));
  });

  it('脏 Event 修复过程中取消会立即向上抛出', async () => {
    const controller = new AbortController();
    db.eventDirty.findMany.mockImplementationOnce(async () => {
      controller.abort();
      return [{ eventId: 'event-1' }];
    });

    await expect(repairDirtyEvents(undefined, controller.signal)).rejects.toThrow();
    expect(db.event.findUnique).not.toHaveBeenCalled();
  });
});
