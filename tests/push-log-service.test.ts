import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  articleFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    pushLog: { findMany: mocks.findMany, count: mocks.count },
    article: { findMany: mocks.articleFindMany },
  },
}));

import { listPushLogs } from '@/lib/push-log-service';

describe('push-log-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.articleFindMany.mockResolvedValue([]);
  });

  it('无备注筛选映射为数据库空字符串，而不是界面文案', async () => {
    await listPushLogs(1, 20, null, null, null, true);

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { webhookRemark: '' },
    }));
    expect(mocks.count).toHaveBeenCalledWith({ where: { webhookRemark: '' } });
  });
});
