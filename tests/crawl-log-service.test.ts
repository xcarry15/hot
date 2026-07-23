/**
 * crawl-log-service 单元测试。
 *
 * 锁定查询上限 500、active/latest Job 互斥、articles 分组排序等不变量。
 * 端到端 HTTP 形态仍由 crawl-log-snapshot.test.ts 通过 Route 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  articleFindMany: vi.fn(),
  discardedItemFindMany: vi.fn(),
  sourceFindMany: vi.fn(),
  transaction: vi.fn(),
  readPushSettings: vi.fn(),
  consoleError: vi.fn(),
  technicalQueue: vi.fn(),
  pushTargetStates: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    job: { findMany: mocks.jobFindMany },
    article: { findMany: mocks.articleFindMany },
    discardedItem: { findMany: mocks.discardedItemFindMany },
    source: { findMany: mocks.sourceFindMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/push/policy', () => ({
  readPushSettings: mocks.readPushSettings,
}));
vi.mock('@/lib/technical-work-queue-service', () => ({
  getTechnicalWorkQueue: mocks.technicalQueue,
  invalidateTechnicalWorkQueueCache: vi.fn(),
}));
vi.mock('@/lib/push/delivery', () => ({
  getPushTargetStatesForEvents: mocks.pushTargetStates,
}));

import {
  clampCrawlLogLimit,
  getCrawlLogSnapshot,
} from '@/lib/crawl-log-service';

describe('crawl-log-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 基线：默认返回空。特定用例在内部覆盖。
    mocks.transaction.mockImplementation(async () => [[], [], [], []]);
    mocks.sourceFindMany.mockResolvedValue([]);
    mocks.readPushSettings.mockResolvedValue({
      pushMode: 'realtime',
      minScore: 50,
      minRelevance: 5,
    });
    mocks.technicalQueue.mockResolvedValue([]);
    mocks.pushTargetStates.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clampCrawlLogLimit', () => {
    it('缺省或非法输入 → 500', () => {
      expect(clampCrawlLogLimit(undefined)).toBe(500);
      expect(clampCrawlLogLimit(null)).toBe(500);
      expect(clampCrawlLogLimit(Number.NaN)).toBe(500);
    });

    it('上限 500；超过截断', () => {
      expect(clampCrawlLogLimit(100)).toBe(100);
      expect(clampCrawlLogLimit(500)).toBe(500);
      expect(clampCrawlLogLimit(9999)).toBe(500);
    });

    it('下限 1；小于 1 抬升到 1', () => {
      expect(clampCrawlLogLimit(0)).toBe(1);
      expect(clampCrawlLogLimit(-1)).toBe(1);
    });
  });

  describe('active / latest Job 互斥', () => {
    function setupTxMock(activeValue: unknown[], latestValue: unknown[], articlesValue: unknown[] = [], discardedValue: unknown[] = []) {
      // 用 moquer 直返而不走真实 ops 数组元素
      mocks.transaction.mockImplementation(async () => [
        activeValue,
        latestValue,
        articlesValue,
        discardedValue,
      ]);
    }

    it('空 active + 非空 latest → activeJob=null, latestJob=最新一条', async () => {
      const latest = {
        id: 'jd',
        type: 'full',
        status: 'succeeded',
        currentStage: null,
        progressTotal: 0,
        progressDone: 0,
        progressErrors: 0,
        currentItemLabel: '',
        heartbeatAt: null,
        startedAt: new Date('2026-07-10T10:00:00Z'),
        completedAt: new Date('2026-07-10T11:00:00Z'),
        error: '',
        result: '{"ok":true}',
        createdAt: new Date('2026-07-10T10:00:00Z'),
        updatedAt: new Date('2026-07-10T11:00:00Z'),
      };
      setupTxMock([], [latest]);

      const snapshot = await getCrawlLogSnapshot({ limit: 50 });
      expect(snapshot.activeJob).toBeNull();
      expect(snapshot.latestJob?.id).toBe('jd');
      expect(snapshot.latestJob?.result).toEqual({ ok: true });
    });

    it('非空 active → latestJob=null（无论 latest 是否非空）', async () => {
      const active = {
        id: 'jr',
        type: 'full',
        status: 'running',
        currentStage: 'collect',
        progressTotal: 5,
        progressDone: 1,
        progressErrors: 0,
        currentItemLabel: '',
        heartbeatAt: new Date('2026-07-10T10:00:00Z'),
        startedAt: new Date('2026-07-10T10:00:00Z'),
        completedAt: null,
        error: '',
        result: null,
        createdAt: new Date('2026-07-10T10:00:00Z'),
        updatedAt: new Date('2026-07-10T10:00:00Z'),
      };
      const latest = {
        ...active,
        id: 'jd',
        status: 'completed',
        completedAt: new Date('2026-07-10T09:00:00Z'),
      };
      setupTxMock([active], [latest]);

      const snapshot = await getCrawlLogSnapshot();
      expect(snapshot.activeJob?.id).toBe('jr');
      expect(snapshot.latestJob).toBeNull();
    });

    it('多条 running → 选择最新一条 (createdAt desc 的 [0])', async () => {
      const old = {
        id: 'old',
        type: 'full',
        status: 'running',
        currentStage: 'process',
        progressTotal: 1,
        progressDone: 0,
        progressErrors: 0,
        currentItemLabel: '',
        heartbeatAt: new Date(),
        startedAt: new Date('2026-07-10T09:00:00Z'),
        completedAt: null,
        error: '',
        result: null,
        createdAt: new Date('2026-07-10T09:00:00Z'),
        updatedAt: new Date(),
      };
      const recent = { ...old, id: 'recent', createdAt: new Date('2026-07-10T11:00:00Z') };
      setupTxMock([recent, old], []);

      // 多条 running 时记服务端告警
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const snapshot = await getCrawlLogSnapshot();
      expect(snapshot.activeJob?.id).toBe('recent');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('invariant violation'),
        expect.arrayContaining(['recent', 'old']),
      );
    });

    it('坏 JSON result → null，不抛错', async () => {
      const latest = {
        id: 'jd',
        type: 'full',
        status: 'completed',
        currentStage: null,
        progressTotal: 0,
        progressDone: 0,
        progressErrors: 0,
        currentItemLabel: '',
        heartbeatAt: null,
        startedAt: null,
        completedAt: new Date(),
        error: '',
        result: '{not-json',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setupTxMock([], [latest]);

      const snapshot = await getCrawlLogSnapshot();
      expect(snapshot.latestJob?.result).toBeNull();
    });
  });

  describe('source 分组与排序', () => {
    function setupWithArticles(articles: Array<{ sourceId: string; id: string; name?: string }>) {
      const records = articles.map((a) => ({
        id: a.id,
        title: 't',
        publishedAt: new Date(),
        sourceId: a.sourceId,
        fetchStatus: 'fetched',
        clusterStatus: 'clustered',
        aiStatus: 'pending',
        score: 0,
        eventId: null,
        event: null,
        nextClusterRetryAt: null,
        nextAiRetryAt: null,
        relevance: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        summary: '',
        skipReason: null,
        source: { name: a.name ?? `源 ${a.sourceId}` },
      }));
      mocks.transaction.mockImplementation(async () => [[], [], records, []]);
    }

    it('按 sourceId 分组，相同 source 的多篇文章合并到一组', async () => {
      setupWithArticles([
        { sourceId: 's1', id: 'a1' },
        { sourceId: 's1', id: 'a2' },
        { sourceId: 's2', id: 'b1' },
      ]);

      const snapshot = await getCrawlLogSnapshot();
      // s1 排第一（articles 数量更多），s2 排第二
      expect(snapshot.sources).toHaveLength(2);
      expect(snapshot.sources[0].id).toBe('s1');
      expect(snapshot.sources[0].articles).toHaveLength(2);
      expect(snapshot.sources[1].id).toBe('s2');
      expect(snapshot.sources[1].articles).toHaveLength(1);
    });

    it('同一源内按 publishedAt desc 排序', async () => {
      const t1 = new Date('2026-07-10T10:00:00Z').getTime();
      const t2 = new Date('2026-07-10T12:00:00Z').getTime();
      const records = [
        {
          id: 'older',
          title: 'older',
          publishedAt: new Date(t1),
          sourceId: 's1',
          fetchStatus: 'fetched',
          clusterStatus: 'clustered',
          aiStatus: 'pending',
          score: 0,
          eventId: null,
          event: null,
          nextClusterRetryAt: null,
          nextAiRetryAt: null,
          relevance: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          summary: '',
          skipReason: null,
          source: { name: 'S' },
        },
        {
          id: 'newer',
          title: 'newer',
          publishedAt: new Date(t2),
          sourceId: 's1',
          fetchStatus: 'fetched',
          clusterStatus: 'clustered',
          aiStatus: 'pending',
          score: 0,
          eventId: null,
          event: null,
          nextClusterRetryAt: null,
          nextAiRetryAt: null,
          relevance: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          summary: '',
          skipReason: null,
          source: { name: 'S' },
        },
      ];
      mocks.transaction.mockImplementation(async () => [[], [], records, []]);

      const snapshot = await getCrawlLogSnapshot();
      const s1 = snapshot.sources[0];
      // 同一 source 内的 articles 数组按 publishedAt desc 排序
      expect(s1.articles[0].id).toBe('newer');
      expect(s1.articles[1].id).toBe('older');
    });

    it('只有未入库项的 source 也应出现在快照中', async () => {
      const discarded = {
        id: 'd1',
        sourceId: 's-discarded',
        title: 'filtered article',
        url: 'https://example.com/filtered',
        reason: 'filter:keyword',
        detail: '{}',
        publishedAt: new Date('2026-07-10T12:00:00Z'),
        createdAt: new Date('2026-07-10T12:00:00Z'),
        source: { name: '仅未入库源' },
      };
      mocks.transaction.mockImplementation(async () => [[], [], [], [discarded]]);

      const snapshot = await getCrawlLogSnapshot();

      expect(snapshot.sources).toHaveLength(1);
      expect(snapshot.sources[0]).toMatchObject({
        id: 's-discarded',
        name: '仅未入库源',
        discarded: [expect.objectContaining({ id: 'd1' })],
      });
    });

    it('源健康只取最近一次采集 Job，不被更新的 AI Job 覆盖', async () => {
      const collect = {
        id: 'collect-job',
        type: 'full',
        status: 'completed',
        currentStage: null,
        progressTotal: 1,
        progressDone: 1,
        progressErrors: 1,
        currentItemLabel: '',
        heartbeatAt: null,
        startedAt: new Date('2026-07-10T10:00:00Z'),
        completedAt: new Date('2026-07-10T10:01:00Z'),
        error: '',
        result: JSON.stringify({ stages: { collect: { sources: [
          { sourceId: 's-failed', sourceName: '失败源', success: false, itemsFound: 0, error: 'timeout' },
        ] } } }),
        createdAt: new Date('2026-07-10T10:00:00Z'),
        updatedAt: new Date('2026-07-10T10:01:00Z'),
      };
      const newerAi = { ...collect, id: 'ai-job', type: 'ai', completedAt: new Date('2026-07-10T11:00:00Z') };
      mocks.transaction.mockImplementation(async () => [[], [newerAi, collect], [], [], [
        { id: 's-failed', name: '失败源' },
      ]]);

      const snapshot = await getCrawlLogSnapshot();
      expect(snapshot.sources[0]).toMatchObject({
        id: 's-failed', status: 'error', itemsFound: 0,
        lastRunStatus: 'failed', lastRunError: 'timeout',
      });
    });

    it('fetchedAt 是 unix ms 数字', async () => {
      mocks.transaction.mockImplementation(async () => [[], [], [], []]);
      const before = Date.now();
      const snapshot = await getCrawlLogSnapshot();
      expect(typeof snapshot.fetchedAt).toBe('number');
      expect(snapshot.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.fetchedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  it('文章技术失败原因投影到工作台 DTO', async () => {
    const record = {
      id: 'a-error', title: '失败文章', publishedAt: new Date(), sourceId: 's1',
      fetchStatus: 'failed', fetchError: '正文请求超时', clusterStatus: 'failed', clusterError: '聚类服务异常',
      aiStatus: 'failed', aiError: 'AI 限流', aiConfidence: null, score: 0, isAd: false, reviewStatus: 'general',
      eventId: null, event: null, nextFetchRetryAt: null, nextClusterRetryAt: null, nextAiRetryAt: null,
      relevance: 0, createdAt: new Date(), updatedAt: new Date(), summary: '', skipReason: null, technicalIgnoredAt: null,
      source: { name: 'S' },
    };
    mocks.transaction.mockImplementation(async () => [[], [], [record], [], []]);

    const snapshot = await getCrawlLogSnapshot();
    expect(snapshot.sources[0].articles[0].technicalErrorReasons).toEqual({
      process: '正文请求超时',
      ai: 'AI 限流',
      cluster: '聚类服务异常',
    });
  });

  it('推送失败原因包含目标与最近一次投递错误', async () => {
    const record = {
      id: 'a-push-error', title: '推送失败文章', publishedAt: new Date(), sourceId: 's1',
      fetchStatus: 'fetched', fetchError: null, clusterStatus: 'clustered', clusterError: null,
      aiStatus: 'done', aiError: null, aiConfidence: 90, score: 90, isAd: false, reviewStatus: 'general',
      eventId: 'e1', event: { articleCount: 1, pushedAt: null, nextPushRetryAt: null, representativeArticleId: 'a-push-error', publicStatus: 'unpublished' },
      nextFetchRetryAt: null, nextClusterRetryAt: null, nextAiRetryAt: null,
      relevance: 90, createdAt: new Date(), updatedAt: new Date(), summary: '', skipReason: null, technicalIgnoredAt: null,
      source: { name: 'S' },
    };
    mocks.technicalQueue.mockResolvedValue([]);
    mocks.pushTargetStates.mockResolvedValue(new Map([
      ['e1', [{ latestStatus: 'failure', webhookRemark: '运营群', latestError: 'HTTP 502', webhookUrl: 'https://hook/a', latestCreatedAt: new Date() }]],
    ]));
    mocks.transaction.mockImplementation(async () => [[], [], [record], [], []]);

    const snapshot = await getCrawlLogSnapshot();
    expect(snapshot.sources[0].articles[0].technicalErrorReasons.push).toBe('推送失败：运营群：HTTP 502');
  });

  it('0 篇解析结果作为警告而不是失败源', async () => {
    const job = {
      id: 'collect', type: 'collect', status: 'succeeded', payload: '{}', error: '', currentStage: 'collect',
      progressTotal: 1, progressDone: 1, progressErrors: 0, currentItemLabel: '', heartbeatAt: null,
      startedAt: new Date(), completedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      result: JSON.stringify({ result: { sources: [{ sourceId: 's1', sourceName: 'S', success: true, itemsFound: 0, error: '0 items parsed' }] } }),
    };
    mocks.transaction.mockImplementation(async () => [[], [job], [], [], [{ id: 's1', name: 'S' }]]);

    const snapshot = await getCrawlLogSnapshot();
    expect(snapshot.sources[0]).toMatchObject({ status: 'warning', lastRunStatus: 'warning' });
  });
});
