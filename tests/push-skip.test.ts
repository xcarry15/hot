/**
 * 推送跳过逻辑回归测试
 *
 * 钉住 push.ts:22-24 的短路求值行为，防止未来误改：
 * - pushedAt=null 时第一个条件 `article.pushedAt && !force` = null（falsy），不 return
 * - 实际跳过只发生在：已成功推送 OR 失败重试时间未到
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindUnique: vi.fn(),
  articleUpdate: vi.fn(),
  pushLogCreate: vi.fn(),
  settingFindUnique: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findUnique: mocks.articleFindUnique,
      update: mocks.articleUpdate,
    },
    pushLog: {
      create: mocks.pushLogCreate,
    },
    setting: {
      findUnique: mocks.settingFindUnique,
    },
  },
}));

global.fetch = mocks.fetch as unknown as typeof fetch;

import { pushArticleToFeishu } from '@/lib/push/delivery';

describe('pushArticleToFeishu skip logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleUpdate.mockResolvedValue({});
    mocks.pushLogCreate.mockResolvedValue({});
    mocks.settingFindUnique.mockResolvedValue({ value: '' }); // webhook URL empty
  });

  it('已成功推送（pushedAt 有值）→ 跳过', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a1',
      pushedAt: new Date('2025-01-01'),
      nextRetryAt: null,
    });

    const result = await pushArticleToFeishu('a1');

    expect(result.status).toBe('completed');
    expect(result.message).toBe('已推送过');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pushedAt=null + nextRetryAt=null（新文章）→ 尝试推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a2',
      pushedAt: null,
      nextRetryAt: null,
      score: 60,
      relevance: 60,
      aiStatus: 'done',
      title: 'test',
      url: 'http://example.com',
    });

    const result = await pushArticleToFeishu('a2');

    // webhook URL 未配置 → no_webhooks 状态
    expect(result.status).toBe('no_webhooks');
    expect(mocks.pushLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        articleId: 'a2',
        status: 'failure',
        errorMessage: '没有配置启用的 Feishu Webhook URL',
      }),
    });
  });

  it('未达到推送阈值的文章不能走普通推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'low-score', pushedAt: null, nextRetryAt: null,
      score: 20, relevance: 2, aiStatus: 'done',
      title: '低分文章', url: 'http://example.com/low-score',
    });

    const result = await pushArticleToFeishu('low-score');

    expect(result.status).toBe('failed');
    expect(result.message).toContain('强制推送');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pushedAt=null + nextRetryAt 过期（重试时间到了）→ 尝试推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a3',
      pushedAt: null,
      nextRetryAt: new Date('2020-01-01'), // 已过期
      score: 60,
      relevance: 60,
      aiStatus: 'done',
      title: 'test',
      url: 'http://example.com',
    });

    const result = await pushArticleToFeishu('a3');

    // 不会跳过
    expect(result.status).toBe('no_webhooks');
    expect(mocks.pushLogCreate).toHaveBeenCalled();
  });

  it('pushedAt=null + nextRetryAt 未到 → 跳过', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a4',
      pushedAt: null,
      nextRetryAt: new Date('2099-01-01'), // 未来
    });

    const result = await pushArticleToFeishu('a4');

    expect(result.status).toBe('failed');
    expect(mocks.pushLogCreate).not.toHaveBeenCalled();
  });

  it('force=true 强制推送，即使已成功推送', async () => {
    mocks.articleFindUnique.mockResolvedValue({
      id: 'a5',
      pushedAt: new Date('2025-01-01'),
      nextRetryAt: null,
      score: 60,
      relevance: 60,
      aiStatus: 'done',
      title: 'test',
      url: 'http://example.com',
    });

    const result = await pushArticleToFeishu('a5', true);

    // force 模式下即使已推送也会尝试
    expect(mocks.pushLogCreate).toHaveBeenCalled();
    expect(result.status).toBe('no_webhooks'); // webhook URL 未配置
  });
});
