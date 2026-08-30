/**
 * 重构 #3 唯一调度策略回归测试
 *
 * 验证:
 *  1. collectAllSources 收集所有 enabled + 未熔断 source,不再接收 force。
 *  2. 熔断中的 source 仍被跳过。
 *  3. lastFetchedAt 不影响 collectAllSources 过滤。
 *  4. Scheduler 真实函数 maybeEnqueueCrawl:
 *     - auto_crawl_enabled=false → 直接 return,不调 runJob
 *     - 间隔未到 → 不调 runJob
 *     - 间隔已到 → 调 runJob('full')
 *     - 上次从未抓过 → 调 runJob('full')
 *  5. 单源与单阶段 /api/crawl 不扩大为全流程；手动全流程允许提前恢复技术失败。
 *
 * 直接 import scheduler 模块的 maybeEnqueueCrawl 测试,而不是重复公式。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts mock 了 @/lib/db,这里重新 mock 子集
vi.mock('@/lib/ai', () => ({
  processWithAI: vi.fn(),
}));
vi.mock('@/lib/parser-registry', () => ({
  dispatchParser: vi.fn(async () => ({ success: true, items: [] })),
}));
vi.mock('@/lib/worker-stop', () => ({
  assertNotAborted: vi.fn(),
}));

// 用 vi.hoisted 把 mock 引用提到 vi.mock 之前,避免"在初始化前访问"的错误。
const { mockRunJob, mockSettingStore, mockHasDueTechnicalRecovery } = vi.hoisted(() => {
  const mockRunJob = vi.fn().mockResolvedValue({ queued: true, jobId: 'j-test' });
  const mockSettingStore: Record<string, string> = {};
  const mockHasDueTechnicalRecovery = vi.fn().mockResolvedValue(false);
  return { mockRunJob, mockSettingStore, mockHasDueTechnicalRecovery };
});

vi.mock('@/lib/execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/execution')>();
  return { ...actual, runJob: mockRunJob };
});

vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return {
    ...actual,
    getSetting: async (key: string) => mockSettingStore[key] ?? null,
    setSetting: async (key: string, value: string) => { mockSettingStore[key] = value; },
    readAllSettings: async () => ({ ...mockSettingStore }),
  };
});

vi.mock('node-cron', () => {
  const schedule = vi.fn(() => ({ stop: vi.fn() }));
  return {
    __esModule: true,
    default: { schedule, validate: () => true },
    schedule,
    validate: () => true,
  };
});
vi.mock('@/lib/technical-work-queue-service', () => ({
  hasDueTechnicalRecovery: mockHasDueTechnicalRecovery,
}));

import { collectAllSources } from '@/lib/pipeline/collect';
import { db } from '@/lib/db';
import { maybeEnqueueCrawl, maybeEnqueueTechnicalRetry } from '@/lib/scheduler';

const sourceFindMany = vi.mocked(db.source.findMany);
const jobFindFirst = vi.mocked(db.job.findFirst);

function makeSource(over: Partial<{
  id: string; name: string; enabled: boolean; status: string;
  circuitBreakerUntil: Date | null; lastFetchedAt: Date | null;
}> = {}) {
  return {
    id: over.id ?? 'src-1', name: over.name ?? 'src-1',
    type: 'html', url: 'https://example.com', parserConfig: '{}',
    enabled: over.enabled ?? true, status: over.status ?? 'normal',
    consecutiveFailures: 0,
    circuitBreakerUntil: over.circuitBreakerUntil ?? null,
      lastFetchedAt: over.lastFetchedAt ?? null,
    createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
    deletedAt: null,
  } as unknown as Awaited<ReturnType<typeof db.source.findMany>>[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunJob.mockResolvedValue({ queued: true, jobId: 'j-test' });
  mockHasDueTechnicalRecovery.mockResolvedValue(false);
  jobFindFirst.mockResolvedValue(null);
  Object.keys(mockSettingStore).forEach(k => delete mockSettingStore[k]);
  // 调度器默认免打扰时段跨越午夜；测试固定关闭，避免在 22:00–08:00 执行时误拦截。
  mockSettingStore['crawl_quiet_start'] = '00:00';
  mockSettingStore['crawl_quiet_end'] = '00:00';
});

afterAll(() => { vi.restoreAllMocks(); });

describe('collectAllSources — unified scheduling (#3)', () => {
  it('collects every enabled source (no force parameter)', async () => {
    const sources = [
      makeSource({ id: 'a', name: 'A', lastFetchedAt: new Date(Date.now() - 60_000) }),
      makeSource({ id: 'b', name: 'B', lastFetchedAt: new Date(Date.now() - 1000) }),
    ];
    sourceFindMany.mockResolvedValueOnce(sources);
    const result = await collectAllSources();
    expect(result.results.map(r => r.sourceId).sort()).toEqual(['a', 'b']);
  });

  it('skips sources that are in active circuit breaker', async () => {
    const now = Date.now();
    const future = new Date(now + 60 * 60 * 1000);
    sourceFindMany.mockResolvedValueOnce([
      makeSource({ id: 'a', name: 'A' }),
      makeSource({ id: 'b', name: 'B', status: 'breaker', circuitBreakerUntil: future }),
      makeSource({ id: 'c', name: 'C', status: 'breaker', circuitBreakerUntil: new Date(now - 1000) }),
    ]);
    const result = await collectAllSources();
    expect(result.results.map(r => r.sourceId).sort()).toEqual(['a', 'c']);
  });

  it('collects recently fetched sources (no per-source interval gate)', async () => {
    sourceFindMany.mockResolvedValueOnce([
      makeSource({ id: 'just-now', name: 'just-now', lastFetchedAt: new Date(Date.now() - 1000) }),
    ]);
    const result = await collectAllSources();
    expect(result.results).toHaveLength(1);
  });
});

describe('Scheduler — production maybeEnqueueCrawl', () => {
  it('auto_crawl_enabled=false: never invokes runJob', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'false';
    mockSettingStore['crawl_interval_min'] = '5';
    // 即使 lastCrawlAt 久远,也应该被 auto_crawl=false 阻断
    mockSettingStore['scheduler_last_crawl_at'] = '0';

    const { runJob } = await import('@/lib/execution');
    await maybeEnqueueCrawl({ ...mockSettingStore });

    expect(runJob).not.toHaveBeenCalled();
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('auto_crawl_enabled unset (default false): interval elapsed → does not invoke runJob("full")', async () => {
    // 设置目录默认关闭自动抓取；数据库缺少该 key 也必须保持关闭。
    mockSettingStore['crawl_interval_min'] = '120';
    const oldLast = String(Date.now() - 200 * 60 * 1000);
    mockSettingStore['scheduler_last_crawl_at'] = oldLast;

    await maybeEnqueueCrawl({ ...mockSettingStore });
    expect(mockRunJob).not.toHaveBeenCalled();
    // 未入队时 lastCrawlAt 不应被更新
    const last = mockSettingStore['scheduler_last_crawl_at'];
    expect(last).toBe(oldLast);
  });

  it('interval not elapsed: does NOT invoke runJob', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'true';
    mockSettingStore['crawl_interval_min'] = '120';
    // 上次 1 分钟前抓过,远小于 120 分钟间隔
    mockSettingStore['scheduler_last_crawl_at'] = String(Date.now() - 60 * 1000);

    await maybeEnqueueCrawl({ ...mockSettingStore });
    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('设置标记丢失时使用最近的自动抓取 Job 防止重复入队', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'true';
    mockSettingStore['crawl_interval_min'] = '120';
    mockSettingStore['scheduler_last_crawl_at'] = '0';
    jobFindFirst.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 60 * 1000),
    } as Awaited<ReturnType<typeof db.job.findFirst>>);

    await maybeEnqueueCrawl({ ...mockSettingStore });

    expect(mockRunJob).not.toHaveBeenCalled();
    expect(jobFindFirst).toHaveBeenCalledWith({
      where: { type: 'full', idempotencyKey: { startsWith: 'crawl:' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  });

  it('损坏的间隔配置回退为 120 分钟，不会每分钟重复入队', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'true';
    mockSettingStore['crawl_interval_min'] = 'not-a-number';
    mockSettingStore['scheduler_last_crawl_at'] = String(Date.now() - 60 * 1000);

    await maybeEnqueueCrawl({ ...mockSettingStore });

    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('lastCrawlAt unset (0): invokes runJob("full")', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'true';
    mockSettingStore['crawl_interval_min'] = '120';
    // 没有 lastCrawlAt → 视为首次抓取
    mockSettingStore['scheduler_last_crawl_at'] = '0';

    await maybeEnqueueCrawl({ ...mockSettingStore });
    expect(mockRunJob).toHaveBeenCalledWith('full', { trigger: 'auto' });
  });

  it('interval exactly at boundary: invokes runJob("full")', async () => {
    mockSettingStore['auto_crawl_enabled'] = 'true';
    mockSettingStore['crawl_interval_min'] = '120';
    // 正好整间隔之前
    mockSettingStore['scheduler_last_crawl_at'] = String(Date.now() - 120 * 60 * 1000);

    await maybeEnqueueCrawl({ ...mockSettingStore });
    expect(mockRunJob).toHaveBeenCalledWith('full', { trigger: 'auto' });
  });
});

describe('Manual entry — runJob contract', () => {
  it('runJob("full") without payload (no force)', async () => {
    const { runJob } = await import('@/lib/execution');
    mockRunJob.mockResolvedValueOnce({ queued: true, jobId: 'j-manual' });
    const res = await runJob('full');
    expect(res.queued).toBe(true);
    expect(mockRunJob).toHaveBeenCalledWith('full');
  });

  it('runJob("collect") without payload (no force)', async () => {
    const { runJob } = await import('@/lib/execution');
    mockRunJob.mockResolvedValueOnce({ queued: true, jobId: 'j-manual-c' });
    const res = await runJob('collect');
    expect(res.queued).toBe(true);
    expect(mockRunJob).toHaveBeenCalledWith('collect');
  });
});

describe('Scheduler — technical recovery', () => {
  it('没有到期技术失败时不启动恢复任务', async () => {
    mockHasDueTechnicalRecovery.mockResolvedValue(false);

    await maybeEnqueueTechnicalRetry();

    expect(mockRunJob).not.toHaveBeenCalled();
  });

  it('到期技术失败时启动不采集数据源的全流程', async () => {
    mockHasDueTechnicalRecovery.mockResolvedValue(true);

    await maybeEnqueueTechnicalRetry();

    expect(mockRunJob).toHaveBeenCalledWith('full', {
      trigger: 'auto_retry',
      skipCollect: true,
    });
  });
});
