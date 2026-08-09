import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/tools/route';

describe('tool directory API', () => {
  it('拒绝缺少 HTTPS 链接的正常工具', async () => {
    const response = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '示例工具',
        description: '工具简介',
        category: 'business-support',
        href: null,
        icon: 'store',
        status: 'active',
        tags: [],
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('HTTPS') });
  });
});
