import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock('@/lib/request-json.client', () => ({ requestJson: mocks.requestJson }));

import { fetchCrawlLogSnapshot } from '@/features/crawl-log-api.client';

describe('crawl-log API client', () => {
  it('保留服务端 technicalTotal', async () => {
    mocks.requestJson.mockResolvedValue({ activeJob: null, latestJob: null, sources: [], fetchedAt: 1, technicalTotal: 7 });
    await expect(fetchCrawlLogSnapshot()).resolves.toMatchObject({ technicalTotal: 7 });
  });
});
