import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

function computeUrlHash(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex').slice(0, 16);
}

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdate: vi.fn(),
  pushLogFindMany: vi.fn(),
  pushLogCreate: vi.fn(),
  pushTargetFindUnique: vi.fn(),
  pushTargetFindMany: vi.fn(),
  pushTargetCreate: vi.fn(),
  pushDeliveryFindMany: vi.fn(),
  pushDeliveryUpsert: vi.fn(),
  pushDeliveryUpdateMany: vi.fn(),
  settingFindUnique: vi.fn(),
  webhookConfigs: [] as Array<{ url: string; remark: string; enabled: boolean }>,
  sendWebhook: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: { findUnique: mocks.articleFindUnique },
    event: { findUnique: mocks.eventFindUnique, update: mocks.eventUpdate },
    pushLog: { findMany: mocks.pushLogFindMany, create: mocks.pushLogCreate },
    pushTarget: { findUnique: mocks.pushTargetFindUnique, findMany: mocks.pushTargetFindMany, create: mocks.pushTargetCreate },
    pushDelivery: { findMany: mocks.pushDeliveryFindMany, upsert: mocks.pushDeliveryUpsert, updateMany: mocks.pushDeliveryUpdateMany },
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
    source: { name: '测试源', deletedAt: null },
    ...overrides,
  };
}

describe('Event 推送门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.webhookConfigs = [];
    mocks.sendWebhook.mockResolvedValue({ ok: true, retryCount: 0 });
    mocks.pushTargetFindUnique.mockResolvedValue(null);
    mocks.pushTargetFindMany.mockImplementation(async ({ where }: { where: { urlHash?: { in?: string[] } } }) => {
      const hashes: string[] = where?.urlHash?.in ?? [];
      return hashes.map((hash) => ({ id: `t-${hash.slice(0, 8)}`, urlHash: hash }));
    });
    mocks.pushTargetCreate.mockImplementation(async ({ data }: { data: { name: string; urlHash: string } }) => ({
      id: `t-${data.urlHash.slice(0, 8)}`, name: data.name, urlHash: data.urlHash,
      status: 'sending', leaseOwner: expect.any(String),
    }));
    mocks.pushDeliveryFindMany.mockResolvedValue([]);
    mocks.pushDeliveryUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
    mocks.pushDeliveryUpdateMany.mockResolvedValue({ count: 1 });
    mocks.settingFindUnique.mockImplementation(({ where }: { where: { key: string } }) => Promise.resolve({
      value: where.key === 'push_mode' ? 'realtime' : '50',
    }));
  });

  it('没有 Event 的 Article 不能直接推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({ eventId: null });
    await expect(pushArticleToFeishu('a1')).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.eventFindUnique).not.toHaveBeenCalled();
  });

  it('已完整推送 Event 不会因代表文章变化再次推送 - 使用 PushDelivery 防重', async () => {
    mocks.webhookConfigs = [{ url: 'https://hook/a', remark: 'A', enabled: true }];
    const tid = `t-${computeUrlHash('https://hook/a').slice(0, 8)}`;
    mocks.pushDeliveryFindMany.mockResolvedValue([
      { eventId: 'e1', targetId: tid, status: 'succeeded', createdAt: new Date(), leaseExpiresAt: null },
    ]);
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticleId: 'a2', pushRetryCount: 0,
      representativeArticle: representative({ id: 'a2' }),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ attempted: 0 });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('强制推送也不能绕过聚类状态', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: null, nextPushRetryAt: null,
      representativeArticleId: 'a1', pushRetryCount: 0,
      representativeArticle: representative({ clusterStatus: 'failed' }),
    });
    await expect(pushEventToFeishu('e1', 'repush_all')).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('人工强制推送也不能绕过来源删除门禁', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: null, nextPushRetryAt: null,
      representativeArticleId: 'a1', pushRetryCount: 0,
      representativeArticle: representative({ source: { name: '已删除源', deletedAt: new Date() } }),
    });
    await expect(pushEventToFeishu('e1', 'manual_force')).resolves.toMatchObject({
      status: 'failed',
      message: '代表文章来源已删除，不能推送',
    });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('历史成功但最新失败时 retry_failed 会实际重试该目标', async () => {
    mocks.webhookConfigs = [
      { url: 'https://hook/a', remark: 'A', enabled: true },
      { url: 'https://hook/b', remark: 'B', enabled: true },
    ];
    const tidA = `t-${computeUrlHash('https://hook/a').slice(0, 8)}`;
    const tidB = `t-${computeUrlHash('https://hook/b').slice(0, 8)}`;
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticleId: 'a1', pushRetryCount: 0,
      representativeArticle: representative(),
    });
    mocks.pushDeliveryFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { eventId: 'e1', targetId: tidA, status: 'failed', createdAt: new Date('2026-07-18T12:00:00Z'), leaseExpiresAt: null },
        { eventId: 'e1', targetId: tidB, status: 'succeeded', createdAt: new Date('2026-07-18T12:00:00Z'), leaseExpiresAt: null },
      ]);
    const result = await pushEventToFeishu('e1', 'retry_failed');
    expect(result).toMatchObject({ mode: 'retry_failed', attempted: 1, succeeded: 1, skipped: 1 });
    expect(mocks.pushLogCreate).toHaveBeenCalledTimes(1);
  });

  it('repush_all 向全部启用目标发送', async () => {
    mocks.webhookConfigs = [
      { url: 'https://hook/a', remark: 'A', enabled: true },
      { url: 'https://hook/b', remark: 'B', enabled: true },
    ];
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticleId: 'a1', pushRetryCount: 0,
      representativeArticle: representative(),
    });
    await pushEventToFeishu('e1', 'repush_all');
    expect(mocks.pushLogCreate).toHaveBeenCalledTimes(2);
  });

  it('未配置 Webhook 时不为每个 Event 重复制造失败日志', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', clusterReviewStatus: 'confirmed', pushedAt: null, nextPushRetryAt: null,
      representativeArticleId: 'a1', pushRetryCount: 0,
      representativeArticle: representative(),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ status: 'no_webhooks' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });
});
