import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleFindMany: vi.fn(),
  articleUpdate: vi.fn(),
  pushLogFindMany: vi.fn(),
  pushLogCreate: vi.fn(),
  settingFindUnique: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findUnique: mocks.articleFindUnique,
      findMany: mocks.articleFindMany,
      update: mocks.articleUpdate,
    },
    pushLog: {
      findMany: mocks.pushLogFindMany,
      create: mocks.pushLogCreate,
    },
    setting: { findUnique: mocks.settingFindUnique },
  },
}));

vi.mock('@/lib/shared/async', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/async')>();
  return {
    ...actual,
    abortableDelay: vi.fn().mockResolvedValue(undefined),
    withTimeout: vi.fn((operation: (signal: AbortSignal) => Promise<unknown>) =>
      operation(new AbortController().signal)),
  };
});

global.fetch = mocks.fetch as unknown as typeof fetch;

import { pushArticleToFeishu } from '@/lib/push/delivery';

const webhookA = 'https://open.feishu.cn/open-apis/bot/v2/hook/A';
const webhookB = 'https://open.feishu.cn/open-apis/bot/v2/hook/B';

function response(ok: boolean, status = ok ? 200 : 500): Response {
  return { ok, status, text: vi.fn().mockResolvedValue(ok ? '' : 'failed') } as unknown as Response;
}

describe('partial multi-webhook delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleFindUnique.mockResolvedValue({
      id: 'article-1',
      pushedAt: null,
      nextRetryAt: null,
      score: 80,
      relevance: 90,
      aiStatus: 'done',
      title: '测试文章',
      summary: '摘要',
      brand: '',
      category: '餐饮',
      tags: '[]',
      keyPoints: '[]',
      url: 'https://example.com/article',
      isAd: false,
      createdAt: new Date(),
      originalSource: null,
      source: { name: '测试源' },
    });
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.articleUpdate.mockResolvedValue({});
    mocks.pushLogCreate.mockResolvedValue({});
    mocks.settingFindUnique.mockResolvedValue({
      value: JSON.stringify([
        { url: webhookA, remark: 'A', enabled: true },
        { url: webhookB, remark: 'B', enabled: true },
      ]),
    });
  });

  it('retries only the failed destination after a partial success', async () => {
    mocks.pushLogFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ webhookUrl: webhookA }]);
    mocks.fetch
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true));

    await expect(pushArticleToFeishu('article-1')).resolves.toMatchObject({ status: 'partial' });
    await expect(pushArticleToFeishu('article-1')).resolves.toMatchObject({ status: 'completed' });

    const urls = mocks.fetch.mock.calls.map(call => call[0]);
    expect(urls.filter(url => url === webhookA)).toHaveLength(1);
    expect(urls.filter(url => url === webhookB)).toHaveLength(5);
    expect(mocks.articleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'article-1' },
      data: expect.objectContaining({ pushedAt: expect.any(Date), nextRetryAt: null }),
    }));
  });
});
