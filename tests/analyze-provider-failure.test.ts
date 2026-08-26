/**
 * AI Provider 短暂故障不能污染整条全流程：未开始文章应等待后自动继续。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  articleFindMany: vi.fn(),
  articleCount: vi.fn(),
  articleUpdateMany: vi.fn(),
  processWithAI: vi.fn(),
  toAiProcessArticle: vi.fn((article: unknown) => article),
  getSetting: vi.fn(),
  advanceJobProgress: vi.fn(),
  startJobStage: vi.fn(),
  abortableDelay: vi.fn(),
  assertNotAborted: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    article: {
      findMany: mocks.articleFindMany,
      count: mocks.articleCount,
      updateMany: mocks.articleUpdateMany,
    },
  },
}));
vi.mock('@/lib/ai', () => ({
  processWithAI: mocks.processWithAI,
  toAiProcessArticle: mocks.toAiProcessArticle,
  aiProcessSelect: { id: true },
  AI_MAX_RETRIES: 5,
}));
vi.mock('@/lib/settings', () => ({
  getSetting: mocks.getSetting,
  SETTING_KEYS: { AI_PROVIDER: 'ai_provider', AI_CONCURRENCY: 'ai_concurrency' },
}));
vi.mock('@/lib/job-progress', () => ({
  advanceJobProgress: mocks.advanceJobProgress,
  startJobStage: mocks.startJobStage,
}));
vi.mock('@/lib/shared/async', () => ({
  abortableDelay: mocks.abortableDelay,
  withTimeout: (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
}));
vi.mock('@/lib/worker-stop', () => ({ assertNotAborted: mocks.assertNotAborted }));

import { analyzeAllPending } from '@/lib/pipeline/analyze';

describe('analyzeAllPending Provider 全局异常', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockResolvedValue('1');
    mocks.articleCount.mockResolvedValue(0);
    mocks.articleUpdateMany.mockResolvedValueOnce({ count: 2 });
    mocks.startJobStage.mockResolvedValue(undefined);
    mocks.advanceJobProgress.mockResolvedValue(undefined);
  });

  it('限流时暂停剩余文章，不批量标失败或消耗重试次数', async () => {
    const articles = [
      { id: 'article-1', title: '文章 1' },
      { id: 'article-2', title: '文章 2' },
      { id: 'article-3', title: '文章 3' },
    ];
    mocks.articleCount.mockResolvedValueOnce(3);
    mocks.articleFindMany.mockResolvedValueOnce(articles);
    mocks.processWithAI.mockResolvedValueOnce({
      status: 'deferred',
      errorKind: 'rate_limit',
      globalError: true,
      retryable: true,
    });

    await expect(analyzeAllPending(undefined, 'job-1')).resolves.toEqual({
      total: 3,
      processed: 0,
      errors: 0,
      deferred: 3,
      providerUnavailable: false,
      providerPaused: true,
    });

    expect(mocks.processWithAI).toHaveBeenCalledTimes(1);
    expect(mocks.articleUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ AND: expect.arrayContaining([
        expect.objectContaining({ fetchStatus: 'fetched' }),
        { id: { notIn: ['article-1'] } },
      ]) }),
      data: expect.objectContaining({
        aiStatus: 'pending',
        aiError: null,
        nextAiRetryAt: expect.any(Date),
      }),
    });
    expect(mocks.advanceJobProgress).toHaveBeenLastCalledWith('job-1', expect.objectContaining({
      doneDelta: 2,
      errorDelta: 0,
    }));
  });

  it('单篇批处理超时只进入文章重试，后续文章继续分析', async () => {
    const articles = [
      { id: 'article-1', title: '文章 1' },
      { id: 'article-2', title: '文章 2' },
    ];
    mocks.articleCount.mockResolvedValueOnce(2);
    mocks.articleFindMany
      .mockResolvedValueOnce(articles)
      .mockResolvedValueOnce([]);
    mocks.processWithAI.mockRejectedValueOnce(new Error('AI分析超时 "文章 1"'));
    mocks.processWithAI.mockResolvedValueOnce({ status: 'done' });

    await expect(analyzeAllPending()).resolves.toMatchObject({
      total: 2,
      processed: 1,
      errors: 1,
      deferred: 0,
      providerUnavailable: false,
      providerPaused: false,
    });
    expect(mocks.processWithAI).toHaveBeenCalledTimes(2);
  });

  it('鉴权/配置错误暂停整批，未开始文章只等待恢复、不复制同一错误', async () => {
    const articles = [
      { id: 'article-1', title: '文章 1' },
      { id: 'article-2', title: '文章 2' },
      { id: 'article-3', title: '文章 3' },
    ];
    mocks.articleCount.mockResolvedValueOnce(3);
    mocks.articleFindMany.mockResolvedValueOnce(articles);
    mocks.processWithAI.mockResolvedValueOnce({
      status: 'deferred',
      errorKind: 'configuration',
      globalError: true,
      retryable: false,
      globalMessage: 'opencode: API Key 无效或鉴权失败',
    });

    await expect(analyzeAllPending()).resolves.toMatchObject({
      processed: 0,
      errors: 0,
      deferred: 3,
      providerUnavailable: true,
      providerPaused: true,
    });

    expect(mocks.articleUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        aiStatus: 'pending',
        aiError: null,
        nextAiRetryAt: expect.any(Date),
      }),
    }));
  });

  it('未知运行时异常交给 Job 有限重试，不在 pending 队列内无限空转', async () => {
    mocks.articleCount.mockResolvedValueOnce(1);
    mocks.articleFindMany.mockResolvedValueOnce([{ id: 'article-1', title: '异常文章' }]);
    mocks.processWithAI.mockRejectedValueOnce(new Error('database write failed'));

    await expect(analyzeAllPending()).rejects.toThrow('database write failed');
    expect(mocks.processWithAI).toHaveBeenCalledTimes(1);
  });

  it('单篇请求错误只标记当前文章失败，后续文章继续分析', async () => {
    mocks.articleCount.mockResolvedValueOnce(2);
    mocks.articleFindMany
      .mockResolvedValueOnce([
        { id: 'bad-article', title: '异常文章' },
        { id: 'good-article', title: '正常文章' },
      ])
      .mockResolvedValueOnce([]);
    mocks.processWithAI
      .mockResolvedValueOnce({ status: 'failed', errorKind: 'content', globalError: false })
      .mockResolvedValueOnce({ status: 'done' });

    await expect(analyzeAllPending()).resolves.toMatchObject({
      total: 2,
      processed: 1,
      errors: 1,
      providerPaused: false,
    });
    expect(mocks.processWithAI).toHaveBeenCalledTimes(2);
  });

});
