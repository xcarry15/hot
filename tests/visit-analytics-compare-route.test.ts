import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('@/lib/visit-analytics-report-service', () => ({ getVisitAnalyticsReport: mocks.report }));
vi.mock('@/lib/require-admin-auth', () => ({ requireAdminAuth: () => null }));

import { GET } from '@/app/api/visit-analytics/route';

const base = 'http://localhost/api/visit-analytics?start=2026-11-10&end=2026-11-11';

describe('访问统计对比基准参数', () => {
  it('拒绝非法对比基准，且不触达报表服务', async () => {
    const response = await GET(new Request(`${base}&compare=bad`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: '对比方式无效' });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('默认上一周期，week/off 透传到报表服务', async () => {
    mocks.report.mockReset().mockResolvedValue({ ok: true });
    expect((await GET(new Request(base))).status).toBe(200);
    expect((await GET(new Request(`${base}&compare=week`))).status).toBe(200);
    expect((await GET(new Request(`${base}&compare=off`))).status).toBe(200);
    expect(mocks.report.mock.calls.map((call) => call[2])).toEqual(['previous', 'week', 'off']);
  });
});
