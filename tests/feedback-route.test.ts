import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MutationConflictError extends Error {}
  return {
    MutationConflictError,
    apiError: vi.fn(),
    generateTuningSuggestions: vi.fn(),
    listTuningSuggestions: vi.fn(),
    runExclusiveMutation: vi.fn(),
  };
});

vi.mock('@/lib/api-helpers', () => ({ apiError: mocks.apiError }));
vi.mock('@/lib/feedback-service', () => ({
  applyTuningSuggestion: vi.fn(),
  dismissTuningSuggestion: vi.fn(),
  generateTuningSuggestions: mocks.generateTuningSuggestions,
  listTuningSuggestions: mocks.listTuningSuggestions,
}));
vi.mock('@/lib/mutation-guard', () => ({
  MutationConflictError: mocks.MutationConflictError,
  runExclusiveMutation: mocks.runExclusiveMutation,
}));

import { POST } from '@/app/api/feedback/route';

function generateRequest() {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    body: JSON.stringify({ action: 'generate' }),
  });
}

describe('POST /api/feedback generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTuningSuggestions.mockResolvedValue([{ id: 'suggestion-1' }]);
    mocks.apiError.mockImplementation(() => Response.json({ error: '生成失败' }, { status: 500 }));
  });

  it('仅在写入冲突时保留已有建议并返回成功', async () => {
    mocks.runExclusiveMutation.mockRejectedValue(new mocks.MutationConflictError('任务占用'));

    const response = await POST(generateRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: 'suggestion-1' }]);
    expect(mocks.apiError).not.toHaveBeenCalled();
  });

  it('生成逻辑异常时交给统一错误处理，不伪装成成功', async () => {
    const error = new Error('database unavailable');
    mocks.runExclusiveMutation.mockRejectedValue(error);

    const response = await POST(generateRequest());

    expect(response.status).toBe(500);
    expect(mocks.apiError).toHaveBeenCalledWith(error, 'Failed to update feedback suggestion');
  });
});
