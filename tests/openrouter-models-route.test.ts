import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelCatalog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/model-discovery', () => ({
  fetchModelCatalog,
}));

import { GET } from '@/app/api/settings/openrouter-models/route';

describe('GET /api/settings/openrouter-models', () => {
  beforeEach(() => vi.clearAllMocks());

  it('只校验文本输入输出价格，不因未使用的附加能力价格误删免费模型', async () => {
    fetchModelCatalog.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        data: [{
          id: 'example/text-model:free',
          pricing: {
            prompt: '0',
            completion: '0',
            web_search: '0.01',
          },
        }],
      },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: ['openrouter/free', 'example/text-model:free'],
    });
  });
});
