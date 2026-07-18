import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ articleFindMany: vi.fn(), eventFindMany: vi.fn(), targetStates: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { article: { findMany: mocks.articleFindMany }, event: { findMany: mocks.eventFindMany } } }));
vi.mock('@/lib/push/delivery', () => ({ getPushTargetStatesForEvents: mocks.targetStates }));

import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';

describe('technical work queue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('同一 Article 多种失败只计一项，Event 推送失败只归代表 Article', async () => {
    mocks.articleFindMany.mockResolvedValue([{ id: 'a1', fetchStatus: 'failed', clusterStatus: 'failed', aiStatus: 'failed', skipReason: null, nextClusterRetryAt: null, nextAiRetryAt: null }]);
    mocks.eventFindMany.mockResolvedValue([{ id: 'e1', representativeArticleId: 'a1', nextPushRetryAt: null }, { id: 'e2', representativeArticleId: 'a2', nextPushRetryAt: null }]);
    mocks.targetStates.mockResolvedValue(new Map([
      ['e1', [{ latestStatus: 'failure' }]],
      ['e2', [{ latestStatus: 'failure' }]],
    ]));
    const queue = await getTechnicalWorkQueue();
    expect(queue).toHaveLength(2);
    expect(queue.find((item) => item.articleId === 'a1')?.issues).toEqual(['process_failed', 'cluster_failed', 'ai_failed', 'push_failed']);
    expect(queue.find((item) => item.articleId === 'a2')?.issues).toEqual(['push_failed']);
  });
});
