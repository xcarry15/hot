import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdate: vi.fn(),
  pushLogFindMany: vi.fn(),
  pushLogCreate: vi.fn(),
  settingFindUnique: vi.fn(),
  webhookConfigs: [] as Array<{ url: string; remark: string; enabled: boolean }>,
  sendWebhook: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: { findUnique: mocks.articleFindUnique },
    event: { findUnique: mocks.eventFindUnique, update: mocks.eventUpdate },
    pushLog: { findMany: mocks.pushLogFindMany, create: mocks.pushLogCreate },
    setting: { findUnique: mocks.settingFindUnique },
  },
}));

vi.mock('@/lib/article-related-service', () => ({ getRelatedArticles: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return { ...actual, getWebhookConfigs: vi.fn(() => Promise.resolve(mocks.webhookConfigs)) };
});
vi.mock('@/lib/push/feishu-transport', () => ({ sendFeishuWebhook: mocks.sendWebhook }));

import { pushArticleToFeishu, pushEventToFeishu } from '@/lib/push/delivery';

function representative(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    clusterStatus: 'clustered',
    aiStatus: 'done',
    score: 90,
    relevance: 90,
    title: '测试文章',
    summary: '摘要',
    brand: '',
    category: '餐饮',
    keyPoints: '[]',
    url: 'https://example.com/a1',
    isAd: false,
    createdAt: new Date(),
    originalSource: null,
    source: { name: '测试源' },
    ...overrides,
  };
}

describe('Event 推送门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.webhookConfigs = [];
    mocks.sendWebhook.mockResolvedValue({ ok: true, retryCount: 0 });
    mocks.settingFindUnique.mockImplementation(({ where }: { where: { key: string } }) => Promise.resolve({
      value: where.key === 'push_mode' ? 'realtime' : '50',
    }));
  });

  it('没有 Event 的 Article 不能直接推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({ eventId: null });
    await expect(pushArticleToFeishu('a1')).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.eventFindUnique).not.toHaveBeenCalled();
  });

  it('已完整推送 Event 不会因代表文章变化再次推送', async () => {
    mocks.webhookConfigs = [{ url: 'https://hook/a', remark: 'A', enabled: true }];
    mocks.pushLogFindMany.mockResolvedValue([{ eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'success', createdAt: new Date() }]);
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticle: representative({ id: 'a2' }),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ status: 'completed', attempted: 0 });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('强制推送也不能绕过聚类状态', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: null, nextPushRetryAt: null,
      representativeArticle: representative({ clusterStatus: 'failed' }),
    });
    await expect(pushEventToFeishu('e1', 'repush_all')).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('历史成功但最新失败时 retry_failed 会实际重试该目标', async () => {
    mocks.webhookConfigs = [
      { url: 'https://hook/a', remark: 'A', enabled: true },
      { url: 'https://hook/b', remark: 'B', enabled: true },
    ];
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticle: representative(),
    });
    mocks.pushLogFindMany
      .mockResolvedValueOnce([
        { eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'failure', createdAt: new Date('2026-07-18T12:00:00Z') },
        { eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'success', createdAt: new Date('2026-07-18T11:00:00Z') },
        { eventId: 'e1', webhookUrl: 'https://hook/b', webhookRemark: 'B', status: 'success', createdAt: new Date('2026-07-18T12:00:00Z') },
      ])
      .mockResolvedValueOnce([
        { eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'success', createdAt: new Date('2026-07-18T13:00:00Z') },
        { eventId: 'e1', webhookUrl: 'https://hook/b', webhookRemark: 'B', status: 'success', createdAt: new Date('2026-07-18T12:00:00Z') },
      ]);
    const result = await pushEventToFeishu('e1', 'retry_failed');
    expect(result).toMatchObject({ status: 'completed', mode: 'retry_failed', attempted: 1, succeeded: 1, skipped: 1 });
    expect(mocks.pushLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.pushLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ webhookUrl: 'https://hook/a' }) }));
  });

  it('repush_all 向全部启用目标发送', async () => {
    mocks.webhookConfigs = [
      { url: 'https://hook/a', remark: 'A', enabled: true },
      { url: 'https://hook/b', remark: 'B', enabled: true },
    ];
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticle: representative(),
    });
    mocks.pushLogFindMany
      .mockResolvedValueOnce([
        { eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'success', createdAt: new Date() },
        { eventId: 'e1', webhookUrl: 'https://hook/b', webhookRemark: 'B', status: 'success', createdAt: new Date() },
      ])
      .mockResolvedValueOnce([
        { eventId: 'e1', webhookUrl: 'https://hook/a', webhookRemark: 'A', status: 'success', createdAt: new Date() },
        { eventId: 'e1', webhookUrl: 'https://hook/b', webhookRemark: 'B', status: 'success', createdAt: new Date() },
      ]);
    const result = await pushEventToFeishu('e1', 'repush_all');
    expect(result).toMatchObject({ status: 'completed', attempted: 2, succeeded: 2, skipped: 0 });
    expect(mocks.pushLogCreate).toHaveBeenCalledTimes(2);
  });

  it('未配置 Webhook 时不为每个 Event 重复制造失败日志', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: null, nextPushRetryAt: null,
      representativeArticle: representative(),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ status: 'no_webhooks' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });
});
