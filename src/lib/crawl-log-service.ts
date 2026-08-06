/**
 * Crawl Log snapshot 应用服务。
 *
 * `getCrawlLogSnapshot(limit)` 负责：
 *   - 在单个 `$transaction` 中读取 active jobs / latest jobs / 最近 articles / discarded items；
 *   - 额外按已有技术队列 id 补齐窗口外待办，不扩大普通文章查询范围；
 *   - 解析 Job.payload/result 的安全 JSON；
 *   - 复用 `@/lib/article-pipeline-status` 的纯投影（不许复制条件）；
 *   - 按 sourceId 分组并按 articles+discarded 数量降序排序。
 *
 * 设计约束：
 *   - 不依赖 Next.js Request / Response；
 *   - 普通文章按进入系统时间保留最近窗口；窗口内各数据源文章按发布时间倒序展示，无发布时间时回退到进入系统时间；技术待办按 id 补齐；Job 排序、Source 分组与 active/latest 语义不变；
 *   - Service 内部不出现 no-cache 之类的 HTTP 头，那是 Route 的职责。
 */
import { db } from '@/lib/db';
import { readPushSettings } from '@/lib/push/policy';
import {
  deriveSkipReason,
  isBusinessSkipReason,
  projectArticleSteps,
  type ArticleStepInput,
  type PushThresholds,
} from '@/lib/article-pipeline-status';
import type { Job, Prisma } from '@prisma/client';
import {
  CRAWL_LOG_DEFAULT_LIMIT,
  CRAWL_LOG_MAX_LIMIT,
  type ArticleProgress,
  type CrawlLogJobStatusSnapshot,
  type CrawlLogSnapshot,
  type JobSnapshot,
  type SourceProgress,
} from '@/contracts/crawl-log';
import { isLowAnalysisConfidence } from '@/contracts/ai-confidence';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';
import { readAllSettings } from '@/lib/settings';
import { SETTING_KEYS } from '@/lib/settings-catalog';
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  getQuietHoursEndAt,
  SCHEDULER_TIME_ZONE,
} from '@/lib/quiet-hours';
import { getPushTargetStatesForEvents } from '@/lib/push/delivery';
import { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES } from '@/lib/job-status';

const ACTIVE_JOBS_LIMIT = 5;
const LATEST_JOBS_LIMIT = 5;

const crawlLogArticleSelect = {
  id: true,
  title: true,
  publishedAt: true,
  sourceId: true,
  fetchStatus: true,
  fetchError: true,
  nextFetchRetryAt: true,
  technicalIgnoredAt: true,
  clusterStatus: true,
  clusterError: true,
  nextClusterRetryAt: true,
  aiStatus: true,
  aiError: true,
  aiConfidence: true,
  score: true,
  isAd: true,
  eventId: true,
  event: { select: { articleCount: true, pushedAt: true, nextPushRetryAt: true, representativeArticleId: true, publicStatus: true } },
  nextAiRetryAt: true,
  relevance: true,
  createdAt: true,
  updatedAt: true,
  summary: true,
  skipReason: true,
  source: { select: { name: true } },
} satisfies Prisma.ArticleSelect;

function safeJsonParse<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getCollectNewArticles(result: Record<string, unknown> | null): number | null {
  if (!result) return null;
  const stages = result.stages as Record<string, unknown> | undefined;
  const collect = (stages?.collect ?? result.result ?? result) as Record<string, unknown> | undefined;
  if (!collect) return null;
  if (typeof collect.totalNewArticles === 'number' && Number.isFinite(collect.totalNewArticles)) {
    return Math.max(0, collect.totalNewArticles);
  }
  if (typeof collect.newArticles === 'number' && Number.isFinite(collect.newArticles)) {
    return Math.max(0, collect.newArticles);
  }
  const sources = collect.sources as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(sources)) return null;
  const counts = sources
    .map((source) => source.newArticles)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return counts.length > 0 ? counts.reduce((total, value) => total + Math.max(0, value), 0) : null;
}

function isActualCollectionJob(job: Job): boolean {
  if (job.type === 'collect') return true;
  if (job.type !== 'full') return false;
  return safeJsonParse<Record<string, unknown>>(job.payload)?.skipCollect !== true;
}

function parseCrawlIntervalMinutes(value: string | undefined): number {
  const parsed = Number.parseInt(value || '120', 10);
  return Number.isFinite(parsed) ? Math.max(5, parsed) : 120;
}

function parseSchedulerTimestamp(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toJobSnapshot(job: Job): JobSnapshot {
  const payload = safeJsonParse<Record<string, unknown>>(job.payload);
  const payloadArticleId = typeof payload?.articleId === 'string' ? payload.articleId : null;
  const payloadStartAt = typeof payload?.startAt === 'string' ? payload.startAt : null;
  const isSingleArticleWorkflow = payload?.scope === 'single'
    && payload.workflow === true
    && payloadArticleId !== null;
  const workflowStartAt = isSingleArticleWorkflow
    && payloadStartAt !== null
    && ['process', 'cluster', 'ai', 'push'].includes(payloadStartAt)
      ? payloadStartAt as JobSnapshot['workflowStartAt']
      : null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    currentStage: job.currentStage,
    progressTotal: job.progressTotal,
    progressDone: job.progressDone,
    progressErrors: job.progressErrors,
    currentItemLabel: job.currentItemLabel,
    heartbeatAt: job.heartbeatAt ? job.heartbeatAt.toISOString() : null,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    error: job.error,
    result: safeJsonParse<Record<string, unknown>>(job.result),
    activeArticleId: isSingleArticleWorkflow ? payloadArticleId : null,
    workflowStartAt,
  };
}

/** raw limit（来自 query string）→ 实际生效值；上限 500。 */
export function clampCrawlLogLimit(rawLimit: number | null | undefined): number {
  if (rawLimit == null || Number.isNaN(rawLimit)) return CRAWL_LOG_DEFAULT_LIMIT;
  return Math.min(Math.max(1, rawLimit), CRAWL_LOG_MAX_LIMIT);
}

export interface GetCrawlLogSnapshotParams {
  limit?: number;
}

export async function getCrawlLogJobStatus(): Promise<CrawlLogJobStatusSnapshot> {
  const [activeJobs, latestJobs] = await Promise.all([
    db.job.findMany({
      where: { status: { in: [...ACTIVE_JOB_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      take: ACTIVE_JOBS_LIMIT,
    }),
    db.job.findMany({
      where: { status: { in: [...TERMINAL_JOB_STATUSES] } },
      orderBy: { completedAt: 'desc' },
      take: 1,
    }),
  ]);
  if (activeJobs.length > 1) {
    console.error(`[crawl-log-service] invariant violation: ${activeJobs.length} running jobs`);
  }
  const activeJobRaw = activeJobs[0] ?? null;
  return {
    activeJob: activeJobRaw ? toJobSnapshot(activeJobRaw) : null,
    latestJob: activeJobRaw ? null : latestJobs[0] ? toJobSnapshot(latestJobs[0]) : null,
    fetchedAt: Date.now(),
  };
}

/**
 * 取任务中心唯一权威快照：activeJob + latestJob + sources + fetchedAt。
 * 单进程全局单 Job 不变量下，activeJobs ≤ 1；多条时记服务端告警并稳定选择最新一条。
 */
export async function getCrawlLogSnapshot(
  params: GetCrawlLogSnapshotParams = {},
): Promise<CrawlLogSnapshot> {
  const limit = clampCrawlLogLimit(params.limit ?? CRAWL_LOG_DEFAULT_LIMIT);

  // Articles + DiscardedItems + Job 用单次 $transaction，
  // 把跨查询的不一致窗口降到最小。
  // 运行态信息是附加展示，不得让旧的轻量 DB mock 或配置异常阻断工作台主体快照。
  const hasSettingsStore = Boolean(db.setting);
  const [pushSettings, schedulerSettings, technicalItems] = await Promise.all([
    readPushSettings(),
    hasSettingsStore
      ? readAllSettings().catch(() => ({} as Record<string, string>))
      : Promise.resolve<Record<string, string>>({}),
    getTechnicalWorkQueue(),
  ]);
  const technicalByArticleId = new Map(technicalItems.map((item) => [item.articleId, item]));
  const technicalArticleIds = technicalItems.map((item) => item.articleId);

  const [[activeJobs, latestJobs, recentArticles, discarded, configuredSources = []], technicalArticles] = await Promise.all([
    db.$transaction([
      db.job.findMany({
        where: { status: { in: [...ACTIVE_JOB_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        take: ACTIVE_JOBS_LIMIT,
      }),
      db.job.findMany({
        where: { status: { in: [...TERMINAL_JOB_STATUSES] } },
        orderBy: { completedAt: 'desc' },
        take: LATEST_JOBS_LIMIT,
      }),
      db.article.findMany({
        where: { source: { enabled: true, deletedAt: null } },
        // 多取一条只用于判断窗口外是否还有文章，响应仍严格裁成 limit 条。
        take: limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: crawlLogArticleSelect,
      }),
      db.discardedItem.findMany({
        where: { source: { enabled: true, deletedAt: null } },
        // 未入库记录也按进入系统的时间判断窗口，避免旧发布时间挤掉刚发现的记录。
        take: limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          sourceId: true,
          title: true,
          url: true,
          reason: true,
          detail: true,
          publishedAt: true,
          createdAt: true,
          source: { select: { name: true } },
        },
      }),
      db.source.findMany({
        where: { enabled: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      }),
    ]),
    technicalArticleIds.length > 0
      ? db.article.findMany({
          where: { id: { in: technicalArticleIds }, source: { enabled: true, deletedAt: null } },
          select: crawlLogArticleSelect,
        })
      : Promise.resolve([]),
  ]);
  // 独立读取采集终态，避免 UI 的 5 条“最近任务”被后续 AI/处理/推送任务挤掉。
  const collectionJobs = await Promise.resolve(db.job.findMany({
    where: {
      type: { in: ['full', 'collect'] },
      status: { in: [...TERMINAL_JOB_STATUSES] },
    },
    orderBy: { completedAt: 'desc' },
    // full 的 skipCollect 技术恢复不应污染“上次抓取”；最多扫描近期 500 条即可避开它们。
    take: 500,
  })).then((jobs) => Array.isArray(jobs) ? jobs : []);
  const hasMoreArticles = recentArticles.length > limit;
  const hasMoreDiscarded = discarded.length > limit;
  const recentArticleWindow = recentArticles.slice(0, limit);
  const discardedWindow = discarded.slice(0, limit);
  // 普通流水线保持最近 limit 篇；技术待办不受时间窗口限制，并按 id 去重合并。
  const articles = Array.from(new Map(
    [...recentArticleWindow, ...technicalArticles].map((article) => [article.id, article]),
  ).values());
  // 技术队列可能处于短暂缓存中；以本次快照实际可见的文章为准，避免摘要出现列表中找不到的待办。
  const visibleTechnicalArticleIds = new Set(technicalArticles.map((article) => article.id));
  const visibleTechnicalItems = technicalItems.filter((item) => visibleTechnicalArticleIds.has(item.articleId));
  const pushStatesByEvent = await getPushTargetStatesForEvents(
    articles.flatMap((article) => article.eventId ? [article.eventId] : []),
  );

  if (activeJobs.length > 1) {
    console.error(
      `[crawl-log-service] invariant violation: ${activeJobs.length} running jobs`,
      activeJobs.map((j) => j.id),
    );
  }
  const activeJobRaw = activeJobs[0] ?? null;
  const latestJobRaw = activeJobRaw ? null : (latestJobs[0] ?? null);
  // 主查询只保留 5 条供 UI 展示；独立查询负责避免被后续非采集任务挤掉。
  // 后备分支也让轻量测试/故障降级仍可使用已读到的终态事实。
  const latestCollectJobRaw = collectionJobs.find(isActualCollectionJob)
    ?? latestJobs.find(isActualCollectionJob)
    ?? null;

  const activeJob = activeJobRaw ? toJobSnapshot(activeJobRaw) : null;
  const latestJob = latestJobRaw ? toJobSnapshot(latestJobRaw) : null;
  const latestCollectJob = latestCollectJobRaw ? toJobSnapshot(latestCollectJobRaw) : null;

  const now = new Date();
  const quietStart = schedulerSettings[SETTING_KEYS.CRAWL_QUIET_START] || DEFAULT_QUIET_START;
  const quietEnd = schedulerSettings[SETTING_KEYS.CRAWL_QUIET_END] || DEFAULT_QUIET_END;
  const autoCrawlEnabled = schedulerSettings[SETTING_KEYS.AUTO_CRAWL_ENABLED] === 'true';
  const crawlIntervalMin = parseCrawlIntervalMinutes(schedulerSettings[SETTING_KEYS.CRAWL_INTERVAL_MIN]);
  const lastCrawlAt = latestCollectJobRaw?.completedAt?.toISOString()
    ?? latestCollectJobRaw?.startedAt?.toISOString()
    ?? latestCollectJobRaw?.createdAt?.toISOString()
    ?? null;
  // 调度器的真实间隔基准是它成功排队时写入的 marker；手动抓取不应虚构改变自动计划。
  const schedulerLastCrawlAt = parseSchedulerTimestamp(schedulerSettings[SETTING_KEYS.SCHEDULER_LAST_CRAWL_AT]);
  const scheduledAt = schedulerLastCrawlAt === null
    ? null
    : schedulerLastCrawlAt + crawlIntervalMin * 60_000;
  const nextSchedulerTick = new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
  const dueAt = scheduledAt === null ? nextSchedulerTick : new Date(scheduledAt);
  const quietEndAt = getQuietHoursEndAt(now, quietStart, quietEnd, SCHEDULER_TIME_ZONE);
  const nextCrawlDate = autoCrawlEnabled
    ? quietEndAt
      ? (dueAt.getTime() > quietEndAt.getTime() ? dueAt : quietEndAt)
      : (dueAt.getTime() <= now.getTime()
        ? nextSchedulerTick
        : getQuietHoursEndAt(dueAt, quietStart, quietEnd, SCHEDULER_TIME_ZONE) ?? dueAt)
    : null;
  const nextCrawlAt = nextCrawlDate?.toISOString() ?? null;
  const runtime = {
    lastCrawlAt,
    lastCrawlCount: getCollectNewArticles(latestCollectJob?.result ?? null),
    nextCrawlAt,
  };

  const push: PushThresholds = {
    pushMode: pushSettings.pushMode,
    minScore: pushSettings.minScore,
    minRelevance: pushSettings.minRelevance,
    now: new Date(),
  };

  // Job 阶段枚举为 collect|process|ai|push；Article 步骤为 crawl|process|ai|push。
  // P0-4: 不再对所有 pending 文章应用 running overlay。
  // 当前执行器未提供 currentItemId，无法精确定位"正在处理的具体文章"，
  // 伪造单篇转圈会导致状态、筛选、可操作性全部失真。
  // 全局阶段状态通过 Job header badge 和进度条展示，不投射到单篇文章。

  // P0-3: 从最近一次采集 Job 的 result 中提取源级运行事实。
  // 优先级：activeJob.result > latestJob.result（仅看含 collect 阶段的 Job）。
  interface SourceRunResult {
    sourceId: string;
    sourceName: string;
    success: boolean;
    itemsFound: number;
    newArticles?: number;
    error?: string;
  }
  const sourceRunResults = new Map<string, SourceRunResult>();
  function extractSourceResults(result: Record<string, unknown> | null): boolean {
    if (!result) return false;
    // full job: result.stages.collect.sources
    const stages = result.stages as Record<string, Record<string, unknown>> | undefined;
    const collect = stages?.collect ?? result.result as Record<string, unknown> | undefined;
    const sources = collect?.sources as SourceRunResult[] | undefined;
    if (Array.isArray(sources) && sources.length > 0) {
      for (const s of sources) {
        sourceRunResults.set(s.sourceId, s);
      }
      return true;
    }

    // 单数据源 collect Job 的 result 结构与 full Job 不同：
    // { sourceId, result: { success, itemsFound, newArticles, error } }。
    const singleSourceId = typeof result.sourceId === 'string' ? result.sourceId : null;
    const singleResult = result.result as Record<string, unknown> | undefined;
    if (singleSourceId && singleResult) {
      sourceRunResults.set(singleSourceId, {
        sourceId: singleSourceId,
        sourceName: typeof result.sourceName === 'string' ? result.sourceName : '',
        success: singleResult.success === true,
        itemsFound: typeof singleResult.itemsFound === 'number' ? singleResult.itemsFound : 0,
        newArticles: typeof singleResult.newArticles === 'number' ? singleResult.newArticles : 0,
        error: typeof singleResult.error === 'string' ? singleResult.error : undefined,
      });
      return true;
    }
    return false;
  }
  // 只从采集类 Job 读取源结果，避免最近一次 AI/处理/推送 Job 覆盖源健康事实。
  if (!extractSourceResults(activeJob?.result ?? null)) {
    extractSourceResults(latestCollectJob?.result ?? null);
  }

  const bySource = new Map<string, SourceProgress>();
  const enabledSourceIds = new Set(configuredSources.map((source) => source.id));
  const ensureSourceGroup = (sourceId: string, name: string | undefined) => {
    if (!bySource.has(sourceId)) {
      const runResult = sourceRunResults.get(sourceId);
      // P0-3: 没有本次采集事实时明确显示 not-run，不能用历史文章伪造成功。
      let status: SourceProgress['status'] = 'not-run';
      let error: string | undefined;
      let lastRunStatus: SourceProgress['lastRunStatus'] = 'not-run';
      let lastRunNewArticles: number | undefined;
      let lastRunError: string | undefined;
      if (runResult) {
        const isWarning = runResult.error === '0 items parsed';
        lastRunStatus = isWarning ? 'warning' : runResult.success ? 'success' : 'failed';
        lastRunNewArticles = runResult.newArticles ?? 0;
        lastRunError = runResult.error;
        status = isWarning ? 'warning' : runResult.success ? 'success' : 'error';
        error = isWarning ? undefined : runResult.error;
      }
      bySource.set(sourceId, {
        id: sourceId,
        name: name || '未知源',
        status,
        articles: [],
        discarded: [],
        deduped: 0,
        filtered: 0,
        itemsFound: runResult?.itemsFound ?? 0,
        expanded: true,
        error,
        lastRunStatus,
        lastRunNewArticles,
        lastRunError,
      });
    }
    return bySource.get(sourceId)!;
  };

  // 先建立全部未删除数据源，确保 0 条、未运行和失败源不会因没有文章而消失。
  for (const source of configuredSources) {
    ensureSourceGroup(source.id, source.name);
  }

  for (const a of articles) {
    const group = ensureSourceGroup(a.sourceId, a.source?.name);

    const technicalItem = technicalByArticleId.get(a.id);
    const isRepresentative = a.event?.representativeArticleId === a.id;
    const pushFailureReason = isRepresentative && a.eventId
      ? pushStatesByEvent.get(a.eventId)?.find((target) => target.latestStatus === 'failure' || target.latestStatus === 'unknown')
      : undefined;
    const stepInput: ArticleStepInput = {
      fetchStatus: a.fetchStatus,
      clusterStatus: a.clusterStatus,
      aiStatus: a.aiStatus,
      score: a.score,
      relevance: a.relevance,
      eventPushedAt: isRepresentative ? (a.event?.pushedAt ?? null) : null,
      eventNextRetryAt: isRepresentative ? (a.event?.nextPushRetryAt ?? null) : null,
      pushFailed: technicalItem?.issues.includes('push_failed') ?? false,
      pushApplicable: isRepresentative,
    };
    const projection = projectArticleSteps(stepInput, push);
    const skipReason = deriveSkipReason({
      aiStatus: a.aiStatus,
      skipReason: a.skipReason,
      summary: a.summary,
    });
    const businessAiSkipped = a.aiStatus === 'skipped' && isBusinessSkipReason(skipReason);
    // P0-4: 不再应用全局阶段 overlay——没有 currentItemId 时伪造转圈会失真
    const articleProgress: ArticleProgress = {
      id: a.id,
      title: a.title,
      createdAt: a.createdAt.toISOString(),
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
      crawl: projection.crawl,
      process: projection.process,
      cluster: projection.cluster,
      ai: projection.ai,
      score: projection.ai === 'done' || businessAiSkipped ? a.score : null,
      anomalyLabels: [
        ...(a.isAd ? ['ad' as const] : []),
        ...(a.event && a.event.articleCount > 1 && !isRepresentative ? ['duplicate' as const] : []),
        ...(isLowAnalysisConfidence({ aiStatus: a.aiStatus, aiConfidence: a.aiConfidence })
          ? ['low-confidence' as const]
          : []),
      ],
      push: projection.push,
      skipReason,
      // 工作台时间列显示文章首次进入系统的采集入库时间；updatedAt 会被后续流水线/人工修改反复刷新。
      lastTime: a.createdAt.getTime(),
      // P1-6: 推送/AI 重试时间，方便管理员判断"何时自动重试"
      pushRetryAt: projection.pushRetryAt ?? (a.event?.nextPushRetryAt ? a.event.nextPushRetryAt.toISOString() : null),
      processRetryAt: a.fetchStatus === 'failed' && a.nextFetchRetryAt ? a.nextFetchRetryAt.toISOString() : null,
      aiRetryAt: a.nextAiRetryAt ? a.nextAiRetryAt.toISOString() : null,
      clusterStatus: a.clusterStatus as ArticleProgress['clusterStatus'],
      clusterRetryAt: a.clusterStatus === 'failed' && a.nextClusterRetryAt ? a.nextClusterRetryAt.toISOString() : null,
      technicalIssues: technicalItem?.issues ?? [],
      technicalState: a.technicalIgnoredAt ? 'ignored' : (technicalItem?.state ?? null),
      technicalIgnoredAt: a.technicalIgnoredAt?.toISOString() ?? null,
      technicalErrorReasons: {
        ...(a.fetchStatus === 'failed' && a.fetchError ? { process: a.fetchError } : {}),
        ...(a.aiStatus === 'failed' && a.aiError ? { ai: a.aiError } : {}),
        ...(a.clusterStatus === 'failed' && a.clusterError ? { cluster: a.clusterError } : {}),
        ...(pushFailureReason ? {
          push: pushFailureReason.latestStatus === 'unknown'
            ? `投递结果未知${pushFailureReason.latestError ? `：${pushFailureReason.latestError}` : ''}；需要人工强制推送确认`
            : `推送失败：${pushFailureReason.webhookRemark || '投递目标'}${pushFailureReason.latestError ? `：${pushFailureReason.latestError}` : ''}`,
        } : {}),
      },
      isEventRepresentative: isRepresentative,
      isPublic: isRepresentative && a.event?.publicStatus === 'published',
    };
    group.articles.push(articleProgress);
  }

  for (const d of discardedWindow) {
    const group = ensureSourceGroup(d.sourceId, d.source?.name);
    group.discarded.push({
      id: d.id,
      title: d.title,
      url: d.url,
      reason: d.reason,
      detail: safeJsonParse<Record<string, unknown>>(d.detail),
      publishedAt: d.publishedAt ? d.publishedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    });
    if (d.reason.startsWith('dedup:')) {
      group.deduped++;
    } else if (d.reason.startsWith('filter:')) {
      group.filtered++;
    }
  }

  // P0-3: 补充 Job result 中存在但当前快照中无文章/未入库的源（0 条结果 / 失败源）。
  for (const [sourceId, runResult] of sourceRunResults) {
    if (enabledSourceIds.has(sourceId) && !bySource.has(sourceId)) {
      ensureSourceGroup(sourceId, runResult.sourceName);
    }
  }

  const statusRank: Record<SourceProgress['status'], number> = {
    error: 0,
    warning: 1,
    running: 1,
    'not-run': 2,
    success: 3,
  };
  const sources = Array.from(bySource.values()).sort((x, y) => {
    const rankDiff = statusRank[x.status] - statusRank[y.status];
    if (rankDiff !== 0) return rankDiff;
    const xc = x.articles.length + x.discarded.length;
    const yc = y.articles.length + y.discarded.length;
    return yc - xc;
  });
  for (const s of sources) {
    s.articles.sort((a, b) => {
      const at = new Date(a.publishedAt ?? a.createdAt).getTime();
      const bt = new Date(b.publishedAt ?? b.createdAt).getTime();
      const createdAtDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return bt - at || createdAtDiff || b.id.localeCompare(a.id);
    });
  }

  return {
    activeJob,
    latestJob,
    runtime,
    sources,
    fetchedAt: Date.now(),
    hasMoreArticles,
    hasMoreDiscarded,
    technicalTotal: visibleTechnicalItems.filter((item) => item.state === 'manual').length,
    autoRetryTotal: visibleTechnicalItems.filter((item) => item.state === 'auto_retry' || item.state === 'waiting').length,
  };
}
