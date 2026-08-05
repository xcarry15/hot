import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDashboardAnalytics: vi.fn(),
  parseRange: vi.fn(),
}));

vi.mock('@/lib/dashboard-analytics-service', () => ({
  getDashboardAnalytics: mocks.getDashboardAnalytics,
  parseDashboardAnalyticsRange: mocks.parseRange,
}));

import { GET } from '@/app/api/dashboard/analytics/route';

describe('GET /api/dashboard/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseRange.mockReturnValue('all');
    mocks.getDashboardAnalytics.mockResolvedValue({ ok: true });
  });

  it.each(['queued', 'running', 'cancel_requested', 'succeeded', 'completed', 'failed', 'cancelled'])(
    '保留有效抓取状态筛选 %s',
    async (status) => {
      const response = await GET(new Request(`http://localhost/api/dashboard/analytics?crawlStatus=${status}`));

      expect(response.status).toBe(200);
      expect(mocks.getDashboardAnalytics).toHaveBeenCalledWith('all', undefined, expect.objectContaining({ status }));
    },
  );

  it('忽略未知状态而非伪装成任意有效筛选', async () => {
    await GET(new Request('http://localhost/api/dashboard/analytics?crawlStatus=pending'));

    expect(mocks.getDashboardAnalytics).toHaveBeenCalledWith('all', undefined, expect.objectContaining({ status: undefined }));
  });
});
