import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSafe = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http', () => ({
  fetchSafe,
  readResponseText: (response: Response) => response.text(),
}));

import { GET } from '@/app/api/settings/openrouter-models/route';

describe('GET /api/settings/openrouter-models', () => {
  beforeEach(() => vi.clearAllMocks());

  it('只校验文本输入输出价格，不因未使用的附加能力价格误删免费模型', async () => {
    fetchSafe.mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 'example/text-model:free',
        pricing: {
          prompt: '0',
          completion: '0',
          web_search: '0.01',
        },
      }],
    }), { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: ['openrouter/free', 'example/text-model:free'],
    });
  });
});
