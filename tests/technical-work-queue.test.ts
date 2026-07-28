import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ articleFindMany: vi.fn(), articleFindFirst: vi.fn(), eventFindMany: vi.fn(), targetStates: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { article: { findMany: mocks.articleFindMany, findFirst: mocks.articleFindFirst }, event: { findMany: mocks.eventFindMany } } }));
vi.mock('@/lib/push/delivery', () => ({ getPushTargetStatesForEvents: mocks.targetStates }));

import { getTechnicalWorkQueue, hasDueTechnicalRecovery, invalidateTechnicalWorkQueueCache } from '@/lib/technical-work-queue-service';

describe('technical work queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateTechnicalWorkQueueCache();
  });

  it('同一 Article 多种失败只计一项，Event 推送失败只归代表 Article', async () => {
    mocks.articleFindMany.mockResolvedValue([{ id: 'a1', fetchStatus: 'failed', clusterStatus: 'failed', aiStatus: 'failed', skipReason: null, nextClusterRetryAt: null, nextAiRetryAt: null }]);
    mocks.eventFindMany.mockResolvedValue([{ id: 'e1', representativeArticleId: 'a1', nextPushRetryAt: null }, { id: 'e2', representativeArticleId: 'a2', nextPushRetryAt: null }]);
    mocks.targetStates.mockResolvedValue(new Map([
      ['e1', [{ latestStatus: 'failure', latestError: 'Webhook 502' }]],
      ['e2', [{ latestStatus: 'failure', latestError: 'Webhook 502' }]],
    ]));
    const queue = await getTechnicalWorkQueue();
    expect(queue).toHaveLength(2);
    expect(queue.find((item) => item.articleId === 'a1')?.issues).toEqual(['process_failed', 'ai_failed', 'cluster_failed', 'push_failed']);
    expect(queue.find((item) => item.articleId === 'a2')?.issues).toEqual(['push_failed']);
  });

  it('投递结果未知进入人工技术待办，但不当作自动重试目标', async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.eventFindMany.mockResolvedValue([{ id: 'e-unknown', representativeArticleId: 'a-unknown', nextPushRetryAt: new Date(Date.now() + 60_000), representativeArticle: { technicalIgnoredAt: null } }]);
    mocks.targetStates.mockResolvedValue(new Map([
      ['e-unknown', [{ latestStatus: 'unknown', latestError: '投递租约已过期' }]],
    ]));

    await expect(getTechnicalWorkQueue()).resolves.toEqual([
      expect.objectContaining({ articleId: 'a-unknown', issues: ['push_failed'], state: 'manual' }),
    ]);
  });

  it('只查询启用且未删除来源的技术待办', async () => {
    mocks.articleFindMany.mockResolvedValue([]);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.targetStates.mockResolvedValue(new Map());

    await getTechnicalWorkQueue();

    expect(mocks.articleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ source: { is: { enabled: true, deletedAt: null } } }),
    }));
    expect(mocks.eventFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        representativeArticle: { is: { source: { is: { enabled: true, deletedAt: null } } } },
      }),
    }));
  });

  it('AI 服务冷却中的 pending 文章显示为等待，不计为失败', async () => {
    mocks.articleFindMany.mockResolvedValue([{
      id: 'a-waiting', fetchStatus: 'fetched', clusterStatus: 'pending',
      aiStatus: 'pending', skipReason: null, nextFetchRetryAt: null,
      nextClusterRetryAt: null, nextAiRetryAt: new Date(Date.now() + 60_000),
    }]);
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.targetStates.mockResolvedValue(new Map());

    await expect(getTechnicalWorkQueue()).resolves.toEqual([
      expect.objectContaining({ articleId: 'a-waiting', issues: ['ai_waiting'], state: 'waiting' }),
    ]);
  });

  it('AI 等待到期后会触发独立恢复任务', async () => {
    mocks.articleFindFirst.mockResolvedValue({ id: 'a-waiting' });

    await expect(hasDueTechnicalRecovery(new Date('2026-07-27T12:00:00Z'))).resolves.toBe(true);
    expect(mocks.articleFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { aiStatus: 'pending', nextAiRetryAt: { lte: new Date('2026-07-27T12:00:00Z') } },
        ]),
      }),
    }));
  });
});
