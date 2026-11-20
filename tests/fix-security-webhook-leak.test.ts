import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ testWebhook: vi.fn() }));
vi.mock('@/lib/webhook-test-service', () => ({ testWebhook: mocks.testWebhook }));

import { POST } from '@/app/api/settings/test-webhook/route';

describe('P1 安全专项：webhook 测试不回吐上游响应正文', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_TOKEN', '');
  });

  it('上游错误正文被剥离，只保留 HTTP 状态', async () => {
    mocks.testWebhook.mockResolvedValue({
      success: false,
      error: 'HTTP 500: {"internal_detail":"secret-token","stack":"..."}',
    });
    const request = new Request('http://localhost/api/settings/test-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' }),
    });
    const response = await POST(request);
    const body = await response.json() as { error?: string; success?: boolean };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^HTTP 500:/);
    expect(body.error).not.toContain('secret-token');
    expect(body.error).not.toContain('internal_detail');
    expect(JSON.stringify(body)).not.toContain('...');
  });

  it('本地校验类错误原样返回', async () => {
    mocks.testWebhook.mockResolvedValue({ success: false, error: 'URL格式不正确', status: 400 });
    const request = new Request('http://localhost/api/settings/test-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'http://evil.example' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'URL格式不正确' });
  });
});
