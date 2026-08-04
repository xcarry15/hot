import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ validate: vi.fn(), runJob: vi.fn() }));
vi.mock('@/lib/execution', () => ({
  validateBatchArticleRegeneration: mocks.validate,
  runJob: mocks.runJob,
}));
vi.mock('@/lib/api-helpers', () => ({ apiError: () => new Response('{}', { status: 500 }) }));

import { POST } from '@/app/api/articles/batch-workflow/route';

describe('batch article workflow route', () => {
  it('队列状态已变化时不创建 Job', async () => {
    mocks.validate.mockResolvedValue({ ok: false, status: 409, reason: '部分文章已不属于低分析置信队列，请刷新后重试' });
    const request = new Request('http://localhost/api/articles/batch-workflow', {
      method: 'POST',
      body: JSON.stringify({ articleIds: ['a1'] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(409);
    expect(mocks.runJob).not.toHaveBeenCalled();
  });

  it('校验通过后以一个 AI Job 执行批量重跑', async () => {
    mocks.validate.mockResolvedValue({ ok: true, articleIds: ['a1', 'a2'] });
    mocks.runJob.mockResolvedValue({ queued: true, jobId: 'job-1' });
    const request = new Request('http://localhost/api/articles/batch-workflow', {
      method: 'POST',
      body: JSON.stringify({ articleIds: ['a1', 'a2'] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true, jobId: 'job-1', count: 2 });
    expect(mocks.runJob).toHaveBeenCalledWith('ai', { articleIds: ['a1', 'a2'], trigger: 'manual' });
  });
});
