import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ validate: vi.fn(), runJob: vi.fn() }));
vi.mock('@/lib/execution', () => ({ validateSingleArticleWorkflow: mocks.validate, runJob: mocks.runJob }));
vi.mock('@/lib/api-helpers', () => ({ apiError: () => new Response('{}', { status: 500 }) }));

import { POST } from '@/app/api/articles/[id]/workflow/route';

describe('article workflow route', () => {
  it('无失败推送目标时返回 409 且不创建 Job', async () => {
    mocks.validate.mockResolvedValue({ ok: false, status: 409, reason: '当前没有失败的推送目标' });
    const request = new Request('http://localhost/api/articles/a1/workflow', { method: 'POST', body: JSON.stringify({ startAt: 'push', intent: 'retry' }) });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });
    expect(response.status).toBe(409);
    expect(mocks.runJob).not.toHaveBeenCalled();
  });
});
