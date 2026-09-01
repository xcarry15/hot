import { beforeEach, describe, expect, it, vi } from 'vitest';

const testSavedAIModel = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai-client', () => ({ testSavedAIModel }));

import { POST } from '@/app/api/settings/test-ai-model/route';

describe('POST /api/settings/test-ai-model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testSavedAIModel.mockResolvedValue({
      success: true,
      provider: 'openrouter',
      model: 'example/model:free',
      latencyMs: 1200,
    });
  });

  it('接收免费模型并调用服务端保存配置测试', async () => {
    const response = await POST(new Request('http://localhost/api/settings/test-ai-model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openrouter', model: 'example/model:free' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, latencyMs: 1200 });
    expect(testSavedAIModel).toHaveBeenCalledWith('openrouter', 'example/model:free');
  });

  it('拒绝未知 Provider 或空模型', async () => {
    const unknownProvider = await POST(new Request('http://localhost/api/settings/test-ai-model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'unknown', model: 'example/model:free' }),
    }));
    expect(unknownProvider.status).toBe(400);

    const paidProvider = await POST(new Request('http://localhost/api/settings/test-ai-model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
    }));
    expect(paidProvider.status).toBe(400);

    const emptyModel = await POST(new Request('http://localhost/api/settings/test-ai-model', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode', model: ' ' }),
    }));
    expect(emptyModel.status).toBe(400);
    expect(testSavedAIModel).not.toHaveBeenCalled();
  });
});
