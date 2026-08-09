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

  it('从目标关系读取脱敏名称，查询与返回值都不包含 Webhook URL', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'log-1',
      eventId: 'event-1',
      representativeArticleId: 'article-1',
      status: 'success',
      errorMessage: '',
      retryCount: 0,
      webhookRemark: '',
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
      target: { name: 'https://open.feishu.cn/…/***abcd' },
    }]);
    mocks.count.mockResolvedValue(1);

    const result = await listPushLogs(1, 20, null, null, null);

    const select = mocks.findMany.mock.calls[0]?.[0]?.select;
    expect(select).not.toHaveProperty('webhookUrl');
    expect(select.target).toEqual({ select: { name: true } });
    expect(result.items[0]).toMatchObject({ webhookTarget: 'https://open.feishu.cn/…/***abcd' });
    expect(result.items[0]).not.toHaveProperty('webhookUrl');
  });
});
