import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    pushLog: { groupBy: mocks.groupBy },
    $queryRaw: mocks.queryRaw,
  },
}));

import { GET } from '@/app/api/push-log/stats/route';

describe('GET /api/push-log/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.groupBy
      .mockResolvedValueOnce([
        { status: 'success', _count: { _all: 4 } },
        { status: 'failure', _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { webhookRemark: '主群', _count: { _all: 3 } },
        { webhookRemark: '', _count: { _all: 3 } },
      ]);
    mocks.queryRaw.mockResolvedValue([
      { sourceName: '源 A', count: 4 },
      { sourceName: '源 B', count: 2 },
    ]);
  });

  it('使用数据库聚合而不是拉取全量 PushLog', async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.status).toEqual({ all: 6, success: 4, failure: 2 });
    expect(body.sources).toEqual([
      { name: '源 A', count: 4 },
      { name: '源 B', count: 2 },
    ]);
    expect(body.webhooks).toEqual([
      { remark: '主群', count: 3 },
      { remark: '(无备注)', count: 3 },
    ]);
    expect(mocks.groupBy).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });
});
