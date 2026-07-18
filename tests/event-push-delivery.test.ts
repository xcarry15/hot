import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdate: vi.fn(),
  pushLogFindMany: vi.fn(),
  pushLogCreate: vi.fn(),
  settingFindUnique: vi.fn(),
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
  return { ...actual, getWebhookConfigs: vi.fn().mockResolvedValue([]) };
});

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
    tags: '[]',
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
    mocks.settingFindUnique.mockImplementation(({ where }: { where: { key: string } }) => Promise.resolve({
      value: where.key === 'push_mode' ? 'realtime' : '50',
    }));
  });

  it('没有 Event 的 Article 不能直接推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({ eventId: null });
    await expect(pushArticleToFeishu('a1')).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.eventFindUnique).not.toHaveBeenCalled();
  });

  it('已推送 Event 不会因代表文章变化再次推送', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', pushedAt: new Date(), nextPushRetryAt: null,
      representativeArticle: representative({ id: 'a2' }),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ status: 'completed', message: '该事件已推送过' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('强制推送也不能绕过聚类状态', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', pushedAt: null, nextPushRetryAt: null,
      representativeArticle: representative({ clusterStatus: 'failed' }),
    });
    await expect(pushEventToFeishu('e1', true)).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('未配置 Webhook 时不为每个 Event 重复制造失败日志', async () => {
    mocks.eventFindUnique.mockResolvedValue({
      id: 'e1', status: 'active', pushedAt: null, nextPushRetryAt: null,
      representativeArticle: representative(),
    });
    await expect(pushEventToFeishu('e1')).resolves.toMatchObject({ status: 'no_webhooks' });
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });
});
