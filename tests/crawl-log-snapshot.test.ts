/**
 * 重构 #4：/api/crawl-log/status snapshot API 测试。
 *
 * 不连真实 DB——通过 setup.ts 已 mock 的 Prisma client 配置返回值。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Article } from '@prisma/client';
import { db } from '@/lib/db';

const readPushSettingsMock = vi.fn();
const technicalQueueMock = vi.fn();

vi.mock('@/lib/push/policy', () => ({
  readPushSettings: () => readPushSettingsMock(),
}));
vi.mock('@/lib/technical-work-queue-service', () => ({
  getTechnicalWorkQueue: () => technicalQueueMock(),
  invalidateTechnicalWorkQueueCache: vi.fn(),
}));

vi.mock('@/lib/api-helpers', () => ({
  apiError: (err: unknown, fallback: string) => new Response(
    JSON.stringify({ error: err instanceof Error ? err.message : fallback }),
    { status: 500 },
  ),
}));

import { GET } from '@/app/api/crawl-log/status/route';

function r(limit = 500) {
  return new Request(`http://localhost/api/crawl-log/status?limit=${limit}`);
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-1', type: 'full', status: 'running', payload: '{}', result: '{}', error: '',
    currentStage: 'collect', progressTotal: 5, progressDone: 2, progressErrors: 0,
    currentItemLabel: '', heartbeatAt: new Date('2026-07-10T12:00:00Z'),
    createdAt: new Date('2026-07-10T11:00:00Z'), updatedAt: new Date('2026-07-10T12:00:00Z'),
    startedAt: new Date('2026-07-10T11:00:00Z'), completedAt: null,
    ...overrides,
  };
}

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a-1', sourceId: 's-1', url: 'http://ex.com/a', title: 'A',
    originalSource: null, rawContent: '', cleanContent: '', contentHash: '',
    fetchStatus: 'fetched', articleBody: '', relevance: 7, summary: '', brand: '',
    category: '', eventSubjects: '["测试主体"]', eventAction: '发布', eventObject: '测试事项',
    eventKey: '测试主体/发布/测试事项', eventKeyConfidence: 90,
    keyPoints: '[]', score: 70, promptVersion: 'v1',
    aiStatus: 'done', skipReason: null, dedupDetail: null, aiRetryCount: 0,
    nextAiRetryAt: null, isAd: false, pushedAt: null, nextRetryAt: null,
    pushUrgency: 'normal', publishedAt: new Date('2026-07-10T10:00:00Z'),
    createdAt: new Date('2026-07-10T10:00:00Z'), updatedAt: new Date('2026-07-10T11:00:00Z'),
    ...overrides,
  } as Article;
}

function setupMocks(active: Job[], latest: Job[], articles: Article[]) {
  const findMany = db.job.findMany as ReturnType<typeof vi.fn>;
  findMany.mockReset();
  findMany.mockResolvedValueOnce(active).mockResolvedValueOnce(latest);
  (db.article.findMany as ReturnType<typeof vi.fn>).mockReset().mockResolvedValueOnce(articles);
  (db.discardedItem.findMany as ReturnType<typeof vi.fn>).mockReset().mockResolvedValueOnce([]);
  (db.$transaction as ReturnType<typeof vi.fn>).mockReset()
    .mockImplementation(async () => [active, latest, articles, []]);
}

describe('GET /api/crawl-log/status', () => {
  beforeEach(() => {
    readPushSettingsMock.mockReset();
    readPushSettingsMock.mockResolvedValue({ pushMode: 'realtime', minScore: 50, minRelevance: 5 });
    technicalQueueMock.mockResolvedValue([]);
  });

  it('无 Job → activeJob/latestJob=null, sources 非空', async () => {
    setupMocks([], [], [article()]);
    const res = await GET(r());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeJob).toBeNull();
    expect(data.latestJob).toBeNull();
    expect(data.sources).toHaveLength(1);
    expect(typeof data.fetchedAt).toBe('number');
  });

  it('运行 Job → activeJob 含 currentStage/progressDone', async () => {
    setupMocks([job({ id: 'jr', status: 'running', currentStage: 'process', progressTotal: 10, progressDone: 3 })], [], [article()]);
    const res = await GET(r());
    const data = await res.json();
    expect(data.activeJob).toMatchObject({ id: 'jr', currentStage: 'process', progressTotal: 10, progressDone: 3 });
    expect(data.latestJob).toBeNull();
  });

  it('最近完成 Job → latestJob', async () => {
    setupMocks([], [job({ id: 'jd', status: 'completed', completedAt: new Date('2026-07-10T11:30:00Z') })], [article()]);
    const res = await GET(r());
    const data = await res.json();
    expect(data.activeJob).toBeNull();
    expect(data.latestJob?.id).toBe('jd');
  });

  it('坏 JSON result → .result=null 不抛错', async () => {
    setupMocks([], [job({ status: 'completed', result: '{not-json' })], []);
    const res = await GET(r());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.latestJob?.result).toBeNull();
  });

  it('多条 running → 取最新一条（按 createdAt desc 排序后取 [0]）', async () => {
    setupMocks([
      job({ id: 'new', createdAt: new Date('2026-07-10T12:00:00Z') }),
      job({ id: 'old', createdAt: new Date('2026-07-10T11:00:00Z') }),
    ], [], [article()]);
    const res = await GET(r());
    const data = await res.json();
    expect(data.activeJob?.id).toBe('new');
  });

  it('响应包含禁缓存头', async () => {
    setupMocks([], [], []);
    const res = await GET(r());
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
  });
});
