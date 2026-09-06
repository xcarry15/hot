import { describe, expect, it, vi } from 'vitest';
import { getAIInvocationStats, recordAIInvocation } from '@/lib/ai-invocation-service';

describe('AI 调用统计', () => {
  it('按 Provider/模型汇总真实请求及耗时', async () => {
    const database = {
      aiInvocation: {
        groupBy: vi.fn().mockResolvedValue([
          { provider: 'opencode', model: 'big-pickle', outcome: 'success', errorKind: '', _count: { _all: 3 }, _avg: { durationMs: 4000 } },
          { provider: 'opencode', model: 'big-pickle', outcome: 'error', errorKind: 'rate_limit', _count: { _all: 1 }, _avg: { durationMs: 6000 } },
          { provider: 'deepseek', model: 'deepseek-v4-flash', outcome: 'success', errorKind: '', _count: { _all: 2 }, _avg: { durationMs: 2000 } },
        ]),
      },
    };

    await expect(getAIInvocationStats(new Date('2026-09-01'), new Date('2026-09-07'), undefined, database as never)).resolves.toEqual({
      total: 6,
      succeeded: 5,
      failed: 1,
      successRate: 0.8333,
      averageDurationMs: 3666.7,
      failuresByKind: [{ kind: 'rate_limit', count: 1 }],
      byProvider: [
        { provider: 'opencode', model: 'big-pickle', total: 4, succeeded: 3, failed: 1, averageDurationMs: 4500 },
        { provider: 'deepseek', model: 'deepseek-v4-flash', total: 2, succeeded: 2, failed: 0, averageDurationMs: 2000 },
      ],
    });
  });

  it('只写入指标字段，不携带提示词或响应内容', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const database = { aiInvocation: { create } };

    await recordAIInvocation({
      articleId: 'article-1',
      jobId: 'job-1',
      provider: 'opencode',
      model: 'big-pickle',
      outcome: 'error',
      errorKind: 'rate_limit',
      statusCode: 429,
      durationMs: 1234.6,
    }, database as never);

    expect(create).toHaveBeenCalledWith({
      data: {
        articleId: 'article-1',
        jobId: 'job-1',
        operation: 'article_analysis',
        provider: 'opencode',
        model: 'big-pickle',
        outcome: 'error',
        errorKind: 'rate_limit',
        statusCode: 429,
        durationMs: 1235,
      },
    });
  });
});
