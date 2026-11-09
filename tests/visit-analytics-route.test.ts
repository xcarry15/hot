import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/visit-analytics-service', () => ({ recordVisit: mocks.record }));
import { POST } from '@/app/api/public/visits/route';
const payload = { visitorId: 'cf9f99cc-bc24-4cc5-9db0-9b58e8e9470b', kind: 'page', referrer: '' };
function request(body: string, headers: Record<string, string> = {}) { return new Request('http://localhost/api/public/visits', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }); }
describe('公开访问采集边界', () => {
  beforeEach(() => mocks.record.mockReset().mockResolvedValue(undefined));
  it('拒绝跨站、非 JSON、超限和不合法字段', async () => {
    expect((await POST(request(JSON.stringify(payload), { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await POST(request(JSON.stringify(payload), { 'content-type': 'text/plain' }))).status).toBe(403);
    expect((await POST(request('x'.repeat(2050)))).status).toBe(413);
    expect((await POST(request(JSON.stringify({ ...payload, path: '/private' })))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('接收合法请求并且不返回访客信息', async () => {
    const response = await POST(request(JSON.stringify(payload)));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mocks.record).toHaveBeenCalledOnce();
  });
});
