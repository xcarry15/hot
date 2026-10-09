import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExportableSettingDefaults } from '@/lib/settings-catalog';

vi.unmock('@/lib/db');
const collectAllSources = vi.hoisted(() => vi.fn());
const fetchHtmlDetailed = vi.hoisted(() => vi.fn());
const createChatCompletion = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pipeline/collect', () => ({ collectAllSources, crawlSource: vi.fn() }));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/http')>(), fetchHtmlDetailed,
}));
vi.mock('@/lib/ai-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ai-client')>(), createChatCompletion,
}));

const projectRoot = path.resolve(__dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'hot-workflow-sqlite-'));
const databaseUrl = `file:${path.join(temporaryDirectory, 'workflow.db')}`;
let db: PrismaClient;
let prepareArticleForClustering: typeof import('@/lib/execution-article-workflow').prepareArticleForClustering;
let restoreProjectBackup: typeof import('@/lib/backup-service').restoreProjectBackup;
let persistArticleKeywordMatch: typeof import('@/lib/keyword-hit-service').persistArticleKeywordMatch;
let jobProgress: typeof import('@/lib/job-progress');
let jobContext: typeof import('@/lib/job-context');
let executionLease: typeof import('@/lib/execution-lease');

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    timeout: 60_000,
  });
  vi.stubEnv('DATABASE_URL', databaseUrl);
  ({ db } = await import('@/lib/db'));
  ({ prepareArticleForClustering } = await import('@/lib/execution-article-workflow'));
  ({ restoreProjectBackup } = await import('@/lib/backup-service'));
  ({ persistArticleKeywordMatch } = await import('@/lib/keyword-hit-service'));
  jobProgress = await import('@/lib/job-progress');
  jobContext = await import('@/lib/job-context');
  executionLease = await import('@/lib/execution-lease');
}, 90_000);

afterAll(async () => {
  await db?.$disconnect();
  vi.unstubAllEnvs();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_publication_update');
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_category_restore');
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_keyword_hit');
  await db.job.deleteMany();
  await db.eventDirty.deleteMany();
  await db.event.updateMany({ data: { representativeArticleId: null } });
  await db.article.deleteMany();
  await db.event.deleteMany();
  await db.source.deleteMany();
  await db.setting.deleteMany();
  await db.keyword.deleteMany();
  await db.keywordCandidate.deleteMany();
  await db.toolDirectoryItem.deleteMany();
  await db.toolDirectoryCategory.deleteMany();
  await db.source.create({ data: { id: 's1', name: '测试来源', url: 'https://example.com' } });
  await db.event.create({ data: {
    id: 'e1', publicStatus: 'published',
    firstSeenAt: new Date('2026-10-01T00:00:00Z'), lastSeenAt: new Date('2026-10-01T00:00:00Z'),
  } });
  await db.article.createMany({ data: ['a1', 'a2'].map((id, index) => ({
    id, sourceId: 's1', eventId: 'e1', url: `https://example.com/${id}`, title: id,
    aiStatus: 'done', clusterStatus: 'clustered', fetchStatus: 'fetched' as const,
    cleanContent: '正文', score: 95 - index * 10, relevance: 90,
    publicStatus: index === 0 ? 'published' : 'unpublished',
    publicPublishedAt: index === 0 ? new Date('2026-10-01T00:00:00Z') : null,
  })) });
  await db.event.update({ where: { id: 'e1' }, data: { representativeArticleId: 'a1', articleCount: 2 } });
});

describe('真实 SQLite 的 Job 执行所有权', () => {
  const mutations = {
    完成: async () => { await jobProgress.markJobCompleted('j1', { old: true }); },
    失败: () => jobProgress.markJobFailed('j1', 'old failure'),
    取消: () => jobProgress.markJobCancelled('j1', 'old cancellation'),
    阶段切换: () => jobProgress.startJobStage('j1', { stage: 'ai', total: 100 }),
    进度: () => jobProgress.advanceJobProgress('j1', { doneDelta: 1, errorDelta: 1 }),
    心跳: () => jobProgress.touchJobHeartbeat('j1'),
  };

  it.each(Object.keys(mutations) as Array<keyof typeof mutations>)('旧执行器%s时不能覆盖下一次领取的 running 状态', async (action) => {
    await db.job.create({ data: {
      id: 'j1', type: 'process', status: 'running', attempt: 2,
      leaseOwner: 'new-owner', leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    const before = await db.job.findUnique({ where: { id: 'j1' } });
    await jobContext.runWithJobLease({ jobId: 'j1', owner: 'old-owner' }, mutations[action]);
    expect(await db.job.findUnique({ where: { id: 'j1' } })).toEqual(before);
  });

  it('同一进程重新领取也产生不同标识，只有新持有者能续租和完成', async () => {
    await db.job.create({ data: { id: 'j1', type: 'process' } });
    const first = await executionLease.claimJob('j1');
    expect(first).not.toBeNull();
    await db.job.update({ where: { id: 'j1' }, data: { status: 'queued', leaseOwner: '', leaseExpiresAt: null } });
    const second = await executionLease.claimJob('j1');
    expect(second).not.toBeNull();
    expect(second!.owner).not.toBe(first!.owner);
    const before = await db.job.findUnique({ where: { id: 'j1' } });

    await expect(executionLease.renewJobLease(first!)).resolves.toBe(false);
    await jobContext.runWithJobLease(first!, mutations.完成);
    expect(await db.job.findUnique({ where: { id: 'j1' } })).toEqual(before);

    await expect(executionLease.renewJobLease(second!)).resolves.toBe(true);
    await jobContext.runWithJobLease(second!, () => jobProgress.markJobCompleted('j1', { current: true }));
    expect(await db.job.findUnique({ where: { id: 'j1' } })).toMatchObject({
      status: 'succeeded', attempt: 2, leaseOwner: '', result: '{"current":true}',
    });
  });

  it('本轮标识相同但租约已过期时，不允许写入或续租复活', async () => {
    await db.job.create({ data: {
      id: 'j1', type: 'process', status: 'running', leaseOwner: 'expired-owner', leaseExpiresAt: new Date(0),
    } });
    const before = await db.job.findUnique({ where: { id: 'j1' } });
    const lease = { jobId: 'j1', owner: 'expired-owner' };
    await jobContext.runWithJobLease(lease, mutations.完成);
    await expect(executionLease.renewJobLease(lease)).resolves.toBe(false);
    expect(await db.job.findUnique({ where: { id: 'j1' } })).toEqual(before);
  });

  it.each(['完成', '失败'] as const)('终态%s前收到取消请求时立即收尾，不留下运行租约', async (action) => {
    await db.job.create({ data: {
      id: 'j1', type: 'process', status: 'cancel_requested', leaseOwner: 'current-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    } });
    await jobContext.runWithJobLease({ jobId: 'j1', owner: 'current-owner' }, mutations[action]);
    expect(await db.job.findUnique({ where: { id: 'j1' } })).toMatchObject({
      status: 'cancelled', result: '{}', error: 'Stopped by user', leaseOwner: '', leaseExpiresAt: null,
      completedAt: expect.any(Date),
    });
  });

  it('旧执行器迟到失败不能把新持有者的任务重新入队或标记失败', async () => {
    const { runJob } = await import('@/lib/execution');
    const { getActiveMutationName } = await import('@/lib/mutation-guard');
    let reject!: (reason: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<never>((_resolve, rejectOperation) => { reject = rejectOperation; });
    collectAllSources.mockImplementationOnce(() => {
      started();
      return pending;
    });
    const result = await runJob('collect');
    if (!result.queued) throw new Error('Expected accepted Job');
    await entered;
    try {
      await db.job.update({ where: { id: result.jobId }, data: {
        attempt: 2, leaseOwner: 'new-owner', leaseExpiresAt: new Date(Date.now() + 60_000),
        payload: '{"trigger":"recovery"}',
      } });
      const before = await db.job.findUnique({ where: { id: result.jobId } });
      reject(new Error('late old worker failure'));
      await vi.waitFor(() => expect(getActiveMutationName()).toBeNull(), { timeout: 5_000, interval: 10 });
      expect(await db.job.findUnique({ where: { id: result.jobId } })).toEqual(before);
    } finally {
      reject(new Error('cleanup'));
      await vi.waitFor(() => expect(getActiveMutationName()).toBeNull(), { timeout: 5_000, interval: 10 });
    }
  });

  it('旧维护批次返回后不能覆盖新持有者的恢复游标', async () => {
    const { executeMaintenanceJob } = await import('@/lib/execution-maintenance');
    const maintenance = await import('@/lib/maintenance-service');
    await db.job.create({ data: {
      id: 'j1', type: 'maintenance', status: 'running', leaseOwner: 'old-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000), payload: '{"action":"reset-ai"}',
    } });
    let afterHandoff: Awaited<ReturnType<typeof db.job.findUnique>>;
    const reset = vi.spyOn(maintenance, 'resetAiBatch').mockImplementationOnce(async () => {
      afterHandoff = await db.job.update({ where: { id: 'j1' }, data: {
        leaseOwner: 'new-owner', attempt: 2, payload: '{"action":"reset-ai","cursor":"new-cursor"}',
      } });
      return { processed: 1, nextCursor: 'old-cursor' };
    });
    try {
      await expect(jobContext.runWithJobLease({ jobId: 'j1', owner: 'old-owner' }, () => (
        executeMaintenanceJob({ action: 'reset-ai' }, undefined, 'j1')
      ))).rejects.toBeInstanceOf(jobContext.JobLeaseLostError);
      expect(reset).toHaveBeenCalledOnce();
      expect(await db.job.findUnique({ where: { id: 'j1' } })).toEqual(afterHandoff!);
    } finally {
      reset.mockRestore();
    }
  });
});

describe('真实 SQLite 的迟到业务结果', () => {
  async function startLease() {
    const { acquireJobRunnerLease } = await import('@/lib/job-runner-lease');
    const runner = await acquireJobRunnerLease();
    if (!runner) throw new Error('Expected acquired runner');
    await db.job.create({ data: {
      id: 'j1', type: 'process', status: 'running', leaseOwner: 'job-owner',
      leaseExpiresAt: new Date(Date.now() + 300_000),
    } });
    return runner;
  }

  async function replaceRunner() {
    await db.setting.update({ where: { key: '__runtime_job_runner_lease__' }, data: {
      value: '2099-01-01T00:00:00.000Z|replacement-runner',
    } });
  }

  it('正文响应返回时全局执行权已交接，原文章与抓取计数均不被改写', async () => {
    const { fetchArticleDetail } = await import('@/lib/detail-fetcher');
    const runner = await startLease();
    const before = await db.article.findUnique({ where: { id: 'a1' } });
    fetchHtmlDetailed.mockImplementationOnce(async () => {
      await replaceRunner();
      return {
        html: '<article><p>' + '这是用于验证迟到正文响应的合成文章内容。'.repeat(20) + '</p></article>',
        status: 200, finalUrl: 'https://example.com/a1', transport: 'direct', error: null,
      };
    });
    await expect(jobContext.runWithJobLease({ jobId: 'j1', owner: 'job-owner' }, () => (
      fetchArticleDetail('a1', 0)
    ), () => runner.isCurrent())).rejects.toBeInstanceOf(jobContext.JobLeaseLostError);
    expect(fetchHtmlDetailed).toHaveBeenCalledOnce();
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toEqual(before);
    await runner.release();
  });

  it('执行权仍有效时，同样的正文响应可以正常提交', async () => {
    const { fetchArticleDetail } = await import('@/lib/detail-fetcher');
    const runner = await startLease();
    const content = '这是用于验证正常正文响应的合成文章内容。'.repeat(20);
    fetchHtmlDetailed.mockResolvedValueOnce({
      html: '<article><p>' + content + '</p></article>', status: 200,
      finalUrl: 'https://example.com/a1', transport: 'direct', error: null,
    });
    await expect(jobContext.runWithJobLease({ jobId: 'j1', owner: 'job-owner' }, () => (
      fetchArticleDetail('a1', 0)
    ), () => runner.isCurrent())).resolves.toBe(content);
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ cleanContent: content, fetchStatus: 'fetched', fetchError: null });
    await runner.release();
  });

  it.each([true, false])('AI 返回后的执行权交接=%s：只允许当前持有者提交结果', async (handoff) => {
    createChatCompletion.mockReset();
    const ai = await import('@/lib/ai');
    await prepareArticleForClustering('a1', true);
    await db.article.update({ where: { id: 'a1' }, data: {
      aiStatus: 'pending', cleanContent: '这是一段满足 AI 分析长度要求的合成正文。'.repeat(20),
    } });
    const runner = await startLease();
    const before = await db.article.findUniqueOrThrow({ where: { id: 'a1' } });
    const article = await db.article.findUniqueOrThrow({ where: { id: 'a1' }, select: ai.aiProcessSelect });
    createChatCompletion.mockImplementationOnce(async () => {
      if (handoff) await replaceRunner();
      return { content: JSON.stringify({
        event_score: 85, content_score: 80, relevance: 90, confidence: 90,
        is_ad: false, ad_probability: 0,
        summary: '合成品牌宣布开设新的合成门店，披露开店计划及经营安排，相关信息仅用于隔离测试。'.repeat(4),
        brand: ['合成品牌'], category: '餐饮', event_subjects: ['合成品牌'],
        event_action: '开店', event_object: '合成门店', key_points: ['新门店'],
      }), model: 'audit-model', provider: 'openrouter' };
    });
    const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'job-owner' }, () => (
      ai.processWithAI(ai.toAiProcessArticle(article))
    ), () => runner.isCurrent());
    if (handoff) {
      await expect(result).rejects.toBeInstanceOf(jobContext.JobLeaseLostError);
      expect(await db.article.findUnique({ where: { id: 'a1' } })).toEqual(before);
    } else {
      await expect(result).resolves.toMatchObject({ status: 'done' });
      expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({
        aiStatus: 'done', eventSubjects: '["合成品牌"]', eventAction: '开店', aiRetryCount: 0, aiError: null,
      });
    }
    expect(createChatCompletion).toHaveBeenCalledOnce();
    await runner.release();
  });
});

describe('真实 SQLite 的批量 AI 恢复取消', () => {
  const readState = () => Promise.all([
    db.article.findMany({ orderBy: { id: 'asc' } }),
    db.event.findMany({ orderBy: { id: 'asc' } }),
    db.eventClusterAudit.findMany({ orderBy: { id: 'asc' } }),
    db.keywordHit.findMany({ orderBy: [{ articleId: 'asc' }, { keywordId: 'asc' }] }),
  ]);
  it.each(['maintenance', 'pipeline'] as const)('%s 在批次写入后取消时，文章和旧 Event 一起回滚', async (kind) => {
    await db.article.update({ where: { id: 'a1' }, data: { aiStatus: 'failed' } });
    await db.keyword.create({ data: { id: 'reset-keyword', category: '品牌', word: '合成品牌' } });
    await db.keywordHit.create({ data: { articleId: 'a1', keywordId: 'reset-keyword' } });
    await db.eventClusterAudit.create({ data: { articleId: 'a1', assignedEventId: 'e1', actor: 'system', action: 'create', decisionSource: 'exact_key' } });
    const before = await readState();
    const controller = new AbortController();
    const resetModule = await import('@/lib/article-ai-reset');
    const reset = resetModule.resetArticleAiAndEventState;
    const spy = vi.spyOn(resetModule, 'resetArticleAiAndEventState').mockImplementationOnce(async (tx, articles) => {
      await reset(tx, articles);
      controller.abort(new Error('Stopped by user'));
    });
    try {
      const operation = kind === 'maintenance'
        ? (await import('@/lib/maintenance-service')).resetAiBatch('reset-ai-failed', undefined, controller.signal)
        : (await import('@/lib/pipeline/ai-recovery')).normalizeAiRecoveryBacklog(true, new Date(), controller.signal);
      await expect(operation).rejects.toThrow('Stopped by user');
      expect(await readState()).toEqual(before);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('真实 SQLite 的设置重建事务', () => {
  it.each([true, false])('分数写入后的取消=%s：取消回滚批次并保留重建标记', async (cancel) => {
    const runner = await (await import('@/lib/job-runner-lease')).acquireJobRunnerLease();
    expect(runner).not.toBeNull();
    await db.job.create({ data: { id: 'j1', type: 'full', status: 'running', leaseOwner: 'settings-owner', leaseExpiresAt: new Date(Date.now() + 300_000) } });
    await db.article.update({ where: { id: 'a1' }, data: { eventScore: 60, contentScore: 60 } });
    const service = await import('@/lib/settings-rebuild-service');
    const marker = JSON.stringify({ id: 'audit-plan', score: true, publication: false });
    await db.setting.create({ data: { key: service.SETTINGS_REBUILD_KEY, value: marker } });
    const before = await Promise.all([db.article.findMany({ orderBy: { id: 'asc' } }), db.event.findMany({ orderBy: { id: 'asc' } })]);
    const controller = new AbortController();
    const eventService = await import('@/lib/event-service');
    const recalculate = eventService.recalculateEventsInTransaction;
    const spy = vi.spyOn(eventService, 'recalculateEventsInTransaction').mockImplementationOnce(async (tx, ids) => {
      await recalculate(tx, ids);
      if (cancel) controller.abort(new Error('Stopped by user'));
    });
    try {
      const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'settings-owner' }, () => service.rebuildPendingSettings(controller.signal), () => runner!.isCurrent());
      if (cancel) {
        await expect(result).rejects.toThrow('Stopped by user');
        expect(await Promise.all([db.article.findMany({ orderBy: { id: 'asc' } }), db.event.findMany({ orderBy: { id: 'asc' } })])).toEqual(before);
      } else {
        await expect(result).resolves.toMatchObject({ ran: true, recomputed: 1, superseded: false });
        expect((await db.article.findUniqueOrThrow({ where: { id: 'a1' } })).score).not.toBe(before[0][0].score);
      }
      expect((await db.setting.findUniqueOrThrow({ where: { key: service.SETTINGS_REBUILD_KEY } })).value).toBe(cancel ? marker : '');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await runner!.release();
    }
  });
});

describe('真实 SQLite 的 Event 人工操作', () => {
  const actions = ['confirm', 'representative', 'move', 'merge', 'split'] as const;
  type Action = typeof actions[number];
  const seedAction = async (action: Action) => {
    if (action === 'confirm') {
      await db.article.delete({ where: { id: 'a2' } });
      await db.article.update({ where: { id: 'a1' }, data: { clusterStatus: 'needs_review', publicStatus: 'unpublished' } });
      await db.event.update({ where: { id: 'e1' }, data: { clusterReviewStatus: 'pending', representativeArticleId: null, publicStatus: 'unpublished', articleCount: 1 } });
    }
    if (action === 'move' || action === 'merge') {
      const date = new Date('2026-10-10T00:00:00Z');
      await db.event.create({ data: { id: 'e2', firstSeenAt: date, lastSeenAt: date, publicStatus: 'published' } });
      await db.article.create({ data: { id: 'a3', eventId: 'e2', sourceId: 's1', title: '目标成员', url: 'https://example.com/a3', aiStatus: 'done', clusterStatus: 'clustered', cleanContent: '正文', score: 75, relevance: 90, createdAt: date, publicStatus: 'published' } });
      await db.event.update({ where: { id: 'e2' }, data: { representativeArticleId: 'a3', articleCount: 1 } });
    }
  };
  const performAction = async (action: Action) => {
    const service = await import('@/lib/event-service');
    if (action === 'confirm') return service.confirmIndependentArticle('e1', 'a1');
    if (action === 'representative') return service.setEventRepresentative('e1', 'a2');
    if (action === 'move') return service.moveArticleToEvent('e1', 'a1', 'e2');
    if (action === 'merge') return service.mergeEvents('e1', 'e2');
    return service.splitEventArticles('e1', ['a1']);
  };
  const readState = () => Promise.all([
    db.article.findMany({ orderBy: { id: 'asc' } }), db.event.findMany({ orderBy: { id: 'asc' } }),
    db.eventClusterAudit.findMany({ orderBy: { id: 'asc' } }), db.eventDirty.findMany({ orderBy: { id: 'asc' } }),
  ]);

  it.each(actions)('%s 最终快照写入失败，文章、Event、审计和修复队列一起回滚', async (action) => {
    await seedAction(action);
    const before = await readState();
    const { publicArticleDetailCache } = await import('@/lib/public-article-cache');
    publicArticleDetailCache.set('manual-event-audit', { expiresAt: Date.now() + 60_000, value: Promise.resolve(null) });
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE UPDATE OF publicStatus ON articles
      BEGIN SELECT RAISE(ABORT, 'manual event snapshot failure'); END`);
    try {
      await expect(performAction(action)).rejects.toThrow();
      expect(await readState()).toEqual(before);
      expect(publicArticleDetailCache.has('manual-event-audit')).toBe(true);
    } finally {
      publicArticleDetailCache.delete('manual-event-audit');
    }
  });

  it.each(actions)('%s 正常完整提交，清理缓存且每个公开 Event 只有一个已发布代表', async (action) => {
    await seedAction(action);
    const { publicArticleDetailCache } = await import('@/lib/public-article-cache');
    publicArticleDetailCache.set('manual-event-audit', { expiresAt: Date.now() + 60_000, value: Promise.resolve(null) });
    try {
      expect(await performAction(action)).toBeTruthy();
      expect(publicArticleDetailCache.has('manual-event-audit')).toBe(false);
      const events = await db.event.findMany({ where: { status: 'active' }, include: { articles: true } });
      expect(events).toHaveLength(action === 'split' || action === 'move' ? 2 : 1);
      for (const event of events) {
        expect(event.publicStatus).toBe('published');
        expect(event.articles.filter((article) => article.publicStatus === 'published').map((article) => article.id)).toEqual([event.representativeArticleId]);
      }
      if (action === 'representative') {
        expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', representativeManual: true });
      }
      if (action === 'merge') {
        expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ status: 'merged', representativeArticleId: null, publicStatus: 'revoked', articleCount: 0 });
      }
      expect(await db.eventDirty.count()).toBe(0);
      expect(await db.eventClusterAudit.count({ where: { actor: 'admin' } })).toBeGreaterThan(0);
    } finally {
      publicArticleDetailCache.delete('manual-event-audit');
    }
  });
});

describe('真实 SQLite 的人工校准', () => {
  const inputs = {
    identity: { eventIdentity: { subjects: ['测试品牌'], action: '开店', object: '上海新增门店' } },
    score: { eventScore: 10, contentScore: 10, adProbability: 0 },
  };
  const readState = () => Promise.all([
    db.article.findMany({ orderBy: { id: 'asc' } }), db.event.findMany({ orderBy: { id: 'asc' } }),
    db.eventClusterAudit.findMany({ orderBy: { id: 'asc' } }), db.eventDirty.findMany({ orderBy: { id: 'asc' } }),
  ]);

  it('身份修正正常提交，旧 Event 切换代表后文章可重新聚类', async () => {
    const result = await (await import('@/lib/article-service')).updateArticleEditorial('a1', inputs.identity);
    const article = await db.article.findUniqueOrThrow({ where: { id: 'a1' } });
    expect(result).not.toBeNull();
    expect(article.eventId).not.toBeNull();
    expect(article.eventId).not.toBe('e1');
    expect(article).toMatchObject({ clusterStatus: 'clustered', eventKey: '测试品牌/开店/上海新增门店' });
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
    expect(await db.event.findUnique({ where: { id: article.eventId! } })).toMatchObject({ representativeArticleId: 'a1', publicStatus: 'published' });
  });

  it('评分修正正常提交，低分旧代表与公开状态一起切换', async () => {
    await db.article.updateMany({ data: { createdAt: new Date('2026-10-01T00:00:00Z') } });
    await (await import('@/lib/article-service')).updateArticleEditorial('a1', inputs.score);
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ score: 10, publicStatus: 'unpublished' });
    expect(await db.article.findUnique({ where: { id: 'a2' } })).toMatchObject({ publicStatus: 'published' });
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
  });

  it('修改非代表内容，不修改当前代表的公开内容更新时间', async () => {
    const contentUpdatedAt = new Date('2026-10-01T00:00:00Z');
    await db.article.update({ where: { id: 'a1' }, data: { publicContentUpdatedAt: contentUpdatedAt } });
    await (await import('@/lib/article-service')).updateArticleEditorial('a2', { summary: '修正后的内容' });
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ publicContentUpdatedAt: contentUpdatedAt });
    expect(await db.article.findUnique({ where: { id: 'a2' } })).toMatchObject({ summary: '修正后的内容', publicStatus: 'unpublished', publicContentUpdatedAt: null });
  });

  it('评分策略读取期间文章被更新，事务内版本检查保留较新的人工修改', async () => {
    const article = await db.article.findUniqueOrThrow({ where: { id: 'a1' } });
    const aiSettings = await import('@/lib/ai-settings');
    const getPolicy = aiSettings.getAIScorePolicy;
    let afterConcurrentUpdate: Awaited<ReturnType<typeof readState>>;
    const spy = vi.spyOn(aiSettings, 'getAIScorePolicy').mockImplementationOnce(async (...args) => {
      const policy = await getPolicy(...args);
      await db.article.update({ where: { id: 'a1' }, data: { summary: '另一标签页的新修正', updatedAt: new Date(article.updatedAt.getTime() + 1000) } });
      afterConcurrentUpdate = await readState();
      return policy;
    });
    try {
      const service = await import('@/lib/article-service');
      await expect(service.updateArticleEditorial('a1', { ...inputs.score, expectedUpdatedAt: article.updatedAt })).rejects.toBeInstanceOf(service.ArticleRevisionConflictError);
      expect(await readState()).toEqual(afterConcurrentUpdate!);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['identity', 'score'] as const)('%s 保存后旧 Event 重算失败，人工字段与代表、公开投影全部回滚', async (kind) => {
    const before = await readState();
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE UPDATE OF representativeArticleId ON events
      BEGIN SELECT RAISE(ABORT, 'editorial representative failure'); END`);
    await expect((await import('@/lib/article-service')).updateArticleEditorial('a1', inputs[kind])).rejects.toThrow();
    expect(await readState()).toEqual(before);
  });
});

describe('真实 SQLite 的历史一致性修复', () => {
  const phases = ['attached', 'duplicate-key', 'candidate-review'] as const;
  const seedPhase = async (phase: typeof phases[number]) => {
    if (phase === 'attached') {
      await db.article.update({ where: { id: 'a1' }, data: { aiStatus: 'pending' } });
      return;
    }
    const seenAt = new Date('2026-10-02T00:00:00Z');
    await db.event.create({ data: { id: 'e2', status: 'active', createdAt: seenAt, firstSeenAt: seenAt, lastSeenAt: seenAt } });
    if (phase === 'duplicate-key') {
      await db.event.update({ where: { id: 'e1' }, data: { createdAt: new Date('2026-10-01T00:00:00Z') } });
      await db.article.updateMany({ data: { eventKey: 'same-key' } });
      await db.article.update({ where: { id: 'a2' }, data: { eventId: 'e2', publicStatus: 'published' } });
      await db.event.update({ where: { id: 'e2' }, data: { representativeArticleId: 'a2', publicStatus: 'published' } });
    } else {
      await db.eventClusterAudit.create({ data: { articleId: 'a1', assignedEventId: 'e1', candidateEventId: 'e2', actor: 'system', action: 'create', decisionSource: 'rule' } });
    }
  };
  const readState = () => Promise.all([
    db.event.findMany({ orderBy: { id: 'asc' } }), db.article.findMany({ orderBy: { id: 'asc' } }),
    db.eventClusterAudit.findMany({ orderBy: { id: 'asc' } }), db.eventDirty.findMany({ orderBy: { id: 'asc' } }),
  ]);

  it.each(phases.flatMap((phase) => (['normal', 'cancel', 'lease'] as const).map((mode) => ({ phase, mode }))))('$phase 快照写入后 $mode：合法提交或完整回滚', async ({ phase, mode }) => {
    await seedPhase(phase);
    await db.job.create({ data: { id: 'j1', type: 'maintenance', status: 'running', leaseOwner: 'history-owner', leaseExpiresAt: new Date(Date.now() + 300_000) } });
    const before = await readState();
    const controller = new AbortController();
    let current = true;
    const publication = await import('@/lib/public-publication-service');
    const refresh = publication.refreshEventPublicPublication;
    const spy = vi.spyOn(publication, 'refreshEventPublicPublication').mockImplementationOnce(async (...args) => {
      const result = await refresh(...args);
      if (mode === 'cancel') controller.abort(new Error('Stopped by user'));
      if (mode === 'lease') current = false;
      return result;
    });
    try {
      const { repairEventConsistencyPage } = await import('@/lib/event/event-consistency-service');
      const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'history-owner' }, () => repairEventConsistencyPage(phase, undefined, 100, controller.signal), async () => current);
      if (mode === 'normal') {
        await expect(result).resolves.toMatchObject({ repaired: 1, done: true });
        const articleId = phase === 'duplicate-key' ? 'a2' : 'a1';
        const article = await db.article.findUniqueOrThrow({ where: { id: articleId } });
        expect(article.publicStatus).toBe('unpublished');
        if (phase === 'attached') {
          expect(article.eventId).toBeNull();
          expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
        } else {
          expect(article.clusterStatus).toBe('needs_review');
          expect(await db.event.findUnique({ where: { id: phase === 'duplicate-key' ? 'e2' : 'e1' } })).toMatchObject({ representativeArticleId: null, publicStatus: 'revoked', clusterReviewStatus: 'pending' });
        }
      } else {
        await expect(result).rejects.toThrow(mode === 'cancel' ? 'Stopped by user' : 'Job execution lease lost');
        expect(await readState()).toEqual(before);
      }
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(phases)('%s 最终快照失败，不能提交修复或返回下一游标；解除故障后恢复', async (phase) => {
    await seedPhase(phase);
    const before = await readState();
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE UPDATE OF publicStatus ON articles
      BEGIN SELECT RAISE(ABORT, 'history snapshot failure'); END`);
    const { repairEventConsistencyPage } = await import('@/lib/event/event-consistency-service');
    await expect(repairEventConsistencyPage(phase)).rejects.toThrow();
    expect(await readState()).toEqual(before);
    await db.$executeRawUnsafe('DROP TRIGGER reject_publication_update');
    await expect(repairEventConsistencyPage(phase)).resolves.toMatchObject({ repaired: 1, done: true });
  });

  it.each(['duplicate-key', 'candidate-review'] as const)('%s 保留人工确认的独立事件', async (phase) => {
    await seedPhase(phase);
    await db.eventClusterAudit.create({ data: {
      articleId: phase === 'duplicate-key' ? 'a2' : 'a1', assignedEventId: phase === 'duplicate-key' ? 'e2' : 'e1',
      actor: 'admin', action: 'confirm_independent', decisionSource: 'admin', createdAt: new Date('2099-01-01T00:00:00Z'),
    } });
    const before = await readState();
    const { repairEventConsistencyPage } = await import('@/lib/event/event-consistency-service');
    await expect(repairEventConsistencyPage(phase)).resolves.toMatchObject({ repaired: 0 });
    expect(await readState()).toEqual(before);
  });

  it.each(phases)('%s 首次查询期间取消，不能执行修复或推进游标', async (phase) => {
    await seedPhase(phase);
    const before = await readState();
    const controller = new AbortController();
    const reader = (phase === 'candidate-review' ? db.eventClusterAudit : db.article) as unknown as {
      findMany: (args?: unknown) => Promise<unknown[]>;
    };
    const findMany = reader.findMany.bind(reader);
    const spy = vi.spyOn(reader, 'findMany').mockImplementationOnce(async (args) => {
      const rows = await findMany(args);
      controller.abort(new Error('Stopped by user'));
      return rows;
    });
    try {
      const { repairEventConsistencyPage } = await import('@/lib/event/event-consistency-service');
      await expect(repairEventConsistencyPage(phase, undefined, 100, controller.signal)).rejects.toThrow('Stopped by user');
      expect(await readState()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('真实 SQLite 的 EventDirty 消费', () => {
  const readState = () => Promise.all([
    db.event.findMany({ orderBy: { id: 'asc' } }), db.article.findMany({ orderBy: { id: 'asc' } }),
    db.eventDirty.findMany({ orderBy: { id: 'asc' } }),
  ]);

  it.each(['normal', 'cancel', 'lease'] as const)('公开快照写入后 %s：正常完整提交，停止时全部回滚', async (mode) => {
    await db.job.create({ data: { id: 'j1', type: 'maintenance', status: 'running', leaseOwner: 'repair-owner', leaseExpiresAt: new Date(Date.now() + 300_000) } });
    await db.eventDirty.create({ data: { eventId: 'e1', reason: 'audit' } });
    await db.article.update({ where: { id: 'a1' }, data: { aiStatus: 'pending' } });
    const before = await readState();
    const controller = new AbortController();
    let current = true;
    const publication = await import('@/lib/public-publication-service');
    const cache = await import('@/lib/public-article-cache');
    const cacheSpy = vi.spyOn(cache, 'invalidatePublicArticleCache');
    const refresh = publication.refreshEventPublicPublication;
    const spy = vi.spyOn(publication, 'refreshEventPublicPublication').mockImplementationOnce(async (...args) => {
      const result = await refresh(...args);
      if (mode === 'cancel') controller.abort(new Error('Stopped by user'));
      if (mode === 'lease') current = false;
      return result;
    });
    try {
      const { repairDirtyEvents } = await import('@/lib/event/event-consistency-service');
      const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'repair-owner' }, () => repairDirtyEvents(undefined, controller.signal), async () => current);
      if (mode === 'normal') {
        await expect(result).resolves.toBe(1);
        expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
        expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ publicStatus: 'unpublished' });
        expect(await db.article.findUnique({ where: { id: 'a2' } })).toMatchObject({ publicStatus: 'published' });
        expect(await db.eventDirty.count()).toBe(0);
      } else {
        await expect(result).rejects.toThrow(mode === 'cancel' ? 'Stopped by user' : 'Job execution lease lost');
        expect(await readState()).toEqual(before);
      }
      expect(spy).toHaveBeenCalledOnce();
      expect(cacheSpy).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0);
    } finally {
      spy.mockRestore();
      cacheSpy.mockRestore();
    }
  });

  it.each(['publication', 'dirty-delete'] as const)('%s 失败时代表、公开投影与待办完整回滚，解除故障后可恢复', async (stage) => {
    await db.article.update({ where: { id: 'a1' }, data: { aiStatus: 'pending' } });
    await db.eventDirty.create({ data: { eventId: 'e1', reason: 'audit' } });
    const before = await readState();
    await db.$executeRawUnsafe(stage === 'publication'
      ? `CREATE TRIGGER reject_publication_update BEFORE UPDATE OF publicSortAt ON events BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END`
      : `CREATE TRIGGER reject_publication_update BEFORE DELETE ON event_dirty BEGIN SELECT RAISE(ABORT, 'delete failure'); END`);
    const { repairDirtyEvents } = await import('@/lib/event/event-consistency-service');
    await expect(repairDirtyEvents()).resolves.toBe(0);
    expect(await readState()).toEqual(before);
    await db.$executeRawUnsafe('DROP TRIGGER reject_publication_update');
    await expect(repairDirtyEvents()).resolves.toBe(1);
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
    expect(await db.eventDirty.count()).toBe(0);
  });

  it.each(['handoff', 'cancel'] as const)('读取队列期间 %s，旧执行器不能修改 Event 或清除待办', async (mode) => {
    await db.job.create({ data: { id: 'j1', type: 'maintenance', status: 'running', leaseOwner: 'old-owner', leaseExpiresAt: new Date(Date.now() + 300_000) } });
    await db.eventDirty.create({ data: { eventId: 'e1', reason: 'audit' } });
    const before = await Promise.all([db.event.findMany(), db.article.findMany(), db.eventDirty.findMany()]);
    // 把 Prisma thenable 的查询边界适配为 Promise，便于注入响应返回前的交接。
    const reader = db.eventDirty as unknown as {
      findMany: (args?: Parameters<typeof db.eventDirty.findMany>[0]) => Promise<Array<{ eventId: string }>>;
    };
    const findMany = reader.findMany.bind(reader);
    const spy = vi.spyOn(reader, 'findMany').mockImplementationOnce(async (args) => {
      const rows = await findMany(args);
      await db.job.update({ where: { id: 'j1' }, data: mode === 'handoff' ? { leaseOwner: 'new-owner' } : { status: 'cancel_requested' } });
      return rows;
    });
    try {
      const { repairDirtyEvents } = await import('@/lib/event/event-consistency-service');
      await expect(jobContext.runWithJobLease({ jobId: 'j1', owner: 'old-owner' }, () => repairDirtyEvents())).rejects.toThrow(mode === 'handoff' ? 'Job execution lease lost' : 'Job cancelled');
      expect(await Promise.all([db.event.findMany(), db.article.findMany(), db.eventDirty.findMany()])).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('真实 SQLite 的来源删除与代表恢复', () => {
  it('公开开关与修复标记原子提交，标记写入失败时开关保持原值', async () => {
    const before = await db.source.findUnique({ where: { id: 's1' } });
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE INSERT ON event_dirty
      BEGIN SELECT RAISE(ABORT, 'dirty failure'); END`);
    await expect((await import('@/lib/source-service')).updateSource('s1', { publicEnabled: false })).rejects.toThrow();
    expect(await db.source.findUnique({ where: { id: 's1' } })).toEqual(before);
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a1', publicStatus: 'published' });
    expect(await db.eventDirty.count()).toBe(0);
  });

  it('关闭来源公开仅撤回发布，队列修复仍保留合格的人工代表', async () => {
    await db.event.update({ where: { id: 'e1' }, data: { representativeManual: true } });
    await (await import('@/lib/source-service')).updateSource('s1', { publicEnabled: false });
    await (await import('@/lib/event/event-consistency-service')).repairDirtyEvents();
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a1', representativeManual: true, publicStatus: 'revoked' });
    expect(await db.eventDirty.count()).toBe(0);
  });

  it('公开开关提交后快照失败，保留代表并通过修复队列恢复公开', async () => {
    const { updateSource } = await import('@/lib/source-service');
    await updateSource('s1', { publicEnabled: false });
    await db.eventDirty.deleteMany();
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE UPDATE OF publicStatus ON articles
      BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END`);
    await expect(updateSource('s1', { publicEnabled: true })).rejects.toThrow();
    expect(await db.source.findUnique({ where: { id: 's1' } })).toMatchObject({ publicEnabled: true });
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a1', publicStatus: 'revoked' });
    expect(await db.eventDirty.count()).toBe(1);
    await db.$executeRawUnsafe('DROP TRIGGER reject_publication_update');
    await (await import('@/lib/event/event-consistency-service')).repairDirtyEvents();
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a1', publicStatus: 'published' });
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ publicStatus: 'published' });
    expect(await db.eventDirty.count()).toBe(0);
  });

  it('删除代表来源后释放不合格代表，独立队列恢复为其他来源成员', async () => {
    await db.source.create({ data: { id: 's2', name: '保留来源', url: 'https://example.com/remaining' } });
    await db.article.update({ where: { id: 'a2' }, data: { sourceId: 's2' } });
    await db.event.update({ where: { id: 'e1' }, data: { representativeManual: true } });
    await db.eventDirty.create({ data: { id: 'existing-dirty', eventId: 'e1', reason: 'old-repair' } });
    await (await import('@/lib/source-service')).softDeleteSource('s1');
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: null, representativeManual: false, publicStatus: 'revoked' });
    expect(await db.eventDirty.findMany({ where: { eventId: 'e1' } })).toHaveLength(1);
    expect(await db.eventDirty.findUnique({ where: { eventId: 'e1' } })).toMatchObject({ id: 'existing-dirty', reason: 'source-deleted' });
    expect(await (await import('@/lib/event/event-consistency-service')).repairDirtyEvents()).toBe(1);
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ publicStatus: 'unpublished' });
    expect(await db.article.findUnique({ where: { id: 'a2' } })).toMatchObject({ publicStatus: 'published' });
    expect(await db.eventDirty.count()).toBe(0);
  });

  it('删除全部成员来源后，修复不能重新选择已删除来源的代表', async () => {
    await (await import('@/lib/source-service')).softDeleteSource('s1');
    await (await import('@/lib/event/event-consistency-service')).repairDirtyEvents();
    const event = await db.event.findUniqueOrThrow({ where: { id: 'e1' } });
    expect(event.representativeArticleId).toBeNull();
    expect(event.publicStatus).not.toBe('published');
    expect(await db.article.count({ where: { eventId: 'e1', publicStatus: 'published' } })).toBe(0);
    expect(await db.eventDirty.count()).toBe(0);
  });

  it('删除非代表来源，不动其他来源的人工代表或登记无关修复', async () => {
    await db.source.create({ data: { id: 's2', name: '非代表来源', url: 'https://example.com/non-representative' } });
    await db.article.update({ where: { id: 'a2' }, data: { sourceId: 's2' } });
    await db.event.update({ where: { id: 'e1' }, data: { representativeManual: true } });
    const before = await db.event.findUnique({ where: { id: 'e1' } });
    await (await import('@/lib/source-service')).softDeleteSource('s2');
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toEqual(before);
    expect(await db.eventDirty.count()).toBe(0);
  });

  it.each(['dirty', 'representative'] as const)('%s 写入失败时，来源删除、代表撤回和队列一起回滚', async (stage) => {
    const readState = () => Promise.all([
      db.source.findMany({ orderBy: { id: 'asc' } }), db.article.findMany({ orderBy: { id: 'asc' } }),
      db.event.findMany({ orderBy: { id: 'asc' } }), db.eventDirty.findMany({ orderBy: { id: 'asc' } }),
    ]);
    const before = await readState();
    await db.$executeRawUnsafe(stage === 'dirty'
      ? `CREATE TRIGGER reject_publication_update BEFORE INSERT ON event_dirty BEGIN SELECT RAISE(ABORT, 'source release failure'); END`
      : `CREATE TRIGGER reject_publication_update BEFORE UPDATE OF representativeArticleId ON events BEGIN SELECT RAISE(ABORT, 'source release failure'); END`);
    await expect((await import('@/lib/source-service')).softDeleteSource('s1')).rejects.toThrow();
    expect(await readState()).toEqual(before);
  });

  it('来源删除提交后的快照同步失败，旧代表仍已撤回且恢复队列可继续', async () => {
    await db.source.create({ data: { id: 's2', name: '保留来源', url: 'https://example.com/remaining' } });
    await db.article.update({ where: { id: 'a2' }, data: { sourceId: 's2' } });
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_publication_update BEFORE UPDATE OF publicStatus ON articles
      WHEN NEW.id = 'a1' AND OLD.publicStatus = 'unpublished'
      BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END`);
    await expect((await import('@/lib/source-service')).softDeleteSource('s1')).rejects.toThrow();
    expect((await db.source.findUniqueOrThrow({ where: { id: 's1' } })).deletedAt).not.toBeNull();
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: null, publicStatus: 'revoked' });
    expect(await db.article.findUnique({ where: { id: 'a1' } })).toMatchObject({ publicStatus: 'unpublished' });
    expect(await db.eventDirty.count()).toBe(1);
    await db.$executeRawUnsafe('DROP TRIGGER reject_publication_update');
    await (await import('@/lib/event/event-consistency-service')).repairDirtyEvents();
    expect(await db.event.findUnique({ where: { id: 'e1' } })).toMatchObject({ representativeArticleId: 'a2', publicStatus: 'published' });
    expect(await db.eventDirty.count()).toBe(0);
  });
});

describe('真实 SQLite 的发布日期修复', () => {
  it.each([true, false])('公开投影写入失败=%s：日期和 Article/Event 投影必须共同提交', async (fail) => {
    await db.article.update({ where: { id: 'a1' }, data: {
      publishedAt: null,
      rawContent: '<html><head><meta property="article:published_time" content="2026-10-02T10:35:00+08:00"></head><body>合成正文</body></html>',
    } });
    const readState = () => Promise.all([db.article.findUnique({ where: { id: 'a1' } }), db.event.findUnique({ where: { id: 'e1' } })]);
    const before = await readState();
    if (fail) await db.$executeRawUnsafe(`
      CREATE TRIGGER reject_publication_update
      BEFORE UPDATE OF publicSortAt ON events
      BEGIN SELECT RAISE(ABORT, 'publication date failure'); END
    `);
    await (await import('@/lib/pipeline/process')).repairPublishedDates();
    if (fail) {
      expect(await readState()).toEqual(before);
    } else {
      const after = await readState();
      expect(after[0]).toMatchObject({ publishedAt: new Date('2026-10-02T02:35:00Z') });
      expect(after[1]).toMatchObject({ publicSortAt: new Date('2026-10-02T02:35:00Z') });
    }
  });
});

describe('真实 SQLite 的关键词结果事务', () => {
  async function seedKeywordHits() {
    await db.keyword.createMany({ data: [
      { id: 'k1', category: '品牌', word: '旧品牌' },
      { id: 'k2', category: '品牌', word: '新品牌' },
    ] });
    await db.keywordHit.create({ data: { articleId: 'a1', keywordId: 'k1' } });
  }

  async function keywordState() {
    return {
      article: await db.article.findUnique({ where: { id: 'a1' }, select: { keywordMatched: true } }),
      hits: await db.keywordHit.findMany({ where: { articleId: 'a1' }, orderBy: { keywordId: 'asc' } }),
    };
  }

  it.each([true, false])('关键词事务提交前执行权检查失败=%s：拒绝时回滚标记与命中', async (lost) => {
    await seedKeywordHits();
    await db.job.create({ data: { id: 'j1', type: 'process', status: 'running', leaseOwner: 'keyword-owner', leaseExpiresAt: new Date(Date.now() + 300_000) } });
    const before = await keywordState();
    let checks = 0;
    const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'keyword-owner' }, () => persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['新品牌'] }), async () => {
      checks += 1;
      // 前两次允许进入事务；第三次在业务写入完成后拒绝提交。
      return !lost || checks < 3;
    });
    if (lost) {
      await expect(result).rejects.toBeInstanceOf(jobContext.JobLeaseLostError);
      expect(await keywordState()).toEqual(before);
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(await keywordState()).toMatchObject({ article: { keywordMatched: true }, hits: [{ keywordId: 'k2' }] });
    }
  });

  it('新命中明细写入失败时，标记和已删除的旧明细一起回滚', async () => {
    await seedKeywordHits();
    const before = await keywordState();
    await db.$executeRawUnsafe(`
      CREATE TRIGGER reject_keyword_hit
      BEFORE INSERT ON keyword_hits
      BEGIN SELECT RAISE(ABORT, 'keyword hit failure'); END
    `);

    await expect(persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['新品牌'] }))
      .rejects.toMatchObject({ meta: { modelName: 'KeywordHit' } });

    expect(await keywordState()).toEqual(before);
  });

  it('匹配和清除时同步替换标记与命中明细', async () => {
    await seedKeywordHits();
    await persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['新品牌', ' 新品牌 '] });
    expect(await keywordState()).toMatchObject({
      article: { keywordMatched: true }, hits: [{ keywordId: 'k2' }],
    });
    expect((await keywordState()).hits).toHaveLength(1);

    await persistArticleKeywordMatch('a1', { matched: false, matchedWords: [] });
    expect(await keywordState()).toEqual({ article: { keywordMatched: false }, hits: [] });
  });

  it('已取消的操作保留原标记和明细', async () => {
    await seedKeywordHits();
    const before = await keywordState();
    const controller = new AbortController();
    controller.abort(new Error('Stopped by user'));
    await expect(persistArticleKeywordMatch('a1', { matched: true, matchedWords: ['新品牌'] }, controller.signal))
      .rejects.toThrow('Stopped by user');
    expect(await keywordState()).toEqual(before);
  });
});

describe('真实 SQLite 的完整备份恢复', () => {
  it('工具目录写入失败时，之前的设置、来源、关键词及级联删除全部回滚', async () => {
    await db.setting.create({ data: { key: 'public_min_score', value: '80' } });
    await db.keyword.create({ data: { id: 'k1', category: '品牌', word: '旧品牌' } });
    await db.keywordHit.create({ data: { articleId: 'a1', keywordId: 'k1' } });
    await db.toolDirectoryCategory.create({ data: { id: 'old-category', name: '旧分类' } });
    const readState = async () => ({
      settings: await db.setting.findMany({ orderBy: { key: 'asc' } }),
      sources: await db.source.findMany({ orderBy: { id: 'asc' } }),
      keywords: await db.keyword.findMany({ orderBy: { id: 'asc' } }),
      keywordHits: await db.keywordHit.findMany(),
      categories: await db.toolDirectoryCategory.findMany(),
      articlesAndEvent: await snapshot(),
    });
    const before = await readState();
    await db.$executeRawUnsafe(`
      CREATE TRIGGER reject_category_restore
      BEFORE INSERT ON tool_directory_categories
      BEGIN SELECT RAISE(ABORT, 'category restore failure'); END
    `);
    const backup = {
      type: 'hot2-project-backup', version: 1, exportedAt: '2026-10-09T00:00:00Z',
      settings: getExportableSettingDefaults(), promptVersions: [],
      sources: [{ id: 'new-source', name: '新来源', type: 'rss', url: 'https://example.com/feed', parserConfig: '{}', enabled: true, publicEnabled: true }],
      keywords: { entries: [{ category: '品牌', word: '新品牌' }], candidates: [] },
      toolDirectory: { categories: [{ id: 'new-category', name: '新分类', sortOrder: 0 }], tools: [] },
    };

    await expect(restoreProjectBackup(backup)).rejects.toMatchObject({
      meta: { modelName: 'ToolDirectoryCategory' },
    });

    expect(await readState()).toEqual(before);
  });
});

async function snapshot() {
  return {
    event: await db.event.findUnique({ where: { id: 'e1' } }),
    articles: await db.article.findMany({ orderBy: { id: 'asc' } }),
  };
}

describe('真实 SQLite 的重跑事务', () => {
  it('最后的公开投影写入失败时，文章脱离、代表切换及公开更新全部回滚', async () => {
    const before = await snapshot();
    await db.$executeRawUnsafe(`
      CREATE TRIGGER reject_publication_update
      BEFORE UPDATE OF publicPublicationEvaluatedAt ON articles
      WHEN NEW.id = 'a1'
      BEGIN SELECT RAISE(ABORT, 'publication failure'); END
    `);

    await expect(prepareArticleForClustering('a1', true)).rejects.toMatchObject({
      meta: { modelName: 'Article' },
    });

    expect(await snapshot()).toEqual(before);
  });

  it('脱离旧 Event 时提交新的唯一代表和公开投影', async () => {
    await prepareArticleForClustering('a1', true);

    const result = await snapshot();
    expect(result.event).toMatchObject({ representativeArticleId: 'a2', articleCount: 1, publicStatus: 'published' });
    expect(result.articles[0]).toMatchObject({ eventId: null, clusterStatus: 'pending', publicStatus: 'unpublished', publicPublishedAt: null });
    expect(result.articles[1]).toMatchObject({ eventId: 'e1', publicStatus: 'published' });
  });

  it('聚类重试保留成员归属，但 pending 文章不能继续充当代表', async () => {
    await prepareArticleForClustering('a1', false);

    const result = await snapshot();
    expect(result.event).toMatchObject({ representativeArticleId: 'a2', articleCount: 2 });
    expect(result.articles[0]).toMatchObject({ eventId: 'e1', clusterStatus: 'pending', publicStatus: 'unpublished' });
    expect(result.articles[1]).toMatchObject({ publicStatus: 'published' });
  });
});


describe('单篇重跑的事务执行权', () => {
  it.each(['cluster', 'refetch'] as const)('%s 在提交前取消或租约交接时整体回滚', async (operation) => {
    const publication = await import('@/lib/public-publication-service');
    const { refetchArticle } = await import('@/lib/article-refetch-service');
    for (const mode of ['cancel', 'lease'] as const) {
      await db.job.upsert({ where: { id: 'j1' }, create: {
        id: 'j1', type: 'process', status: 'running', leaseOwner: 'reset-owner',
        leaseExpiresAt: new Date(Date.now() + 300_000),
      }, update: {} });
      const controller = new AbortController();
      let current = true;
      const before = await snapshot();
      const original = publication.refreshPublicPublication;
      const spy = vi.spyOn(publication, 'refreshPublicPublication').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (mode === 'cancel') controller.abort(new Error('reset cancelled'));
        else current = false;
        return result;
      });
      try {
        const result = jobContext.runWithJobLease({ jobId: 'j1', owner: 'reset-owner' }, async () => {
          if (operation === 'cluster') await prepareArticleForClustering('a1', true, controller.signal);
          else await refetchArticle('a1', controller.signal);
        }, async () => current);
        await expect(result).rejects.toThrow(mode === 'cancel' ? 'reset cancelled' : 'Job execution lease lost');
        expect(await snapshot()).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
