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
 *   - 普通文章查询上限 500；技术待办按 id 补齐；Job 排序、Source 分组与 active/latest 语义不变；
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
import type {
  ArticleProgress,
  CrawlLogJobStatusSnapshot,
  CrawlLogSnapshot,
  JobSnapshot,
  SourceProgress,
} from '@/contracts/crawl-log';
import { getTechnicalWorkQueue } from '@/lib/technical-work-queue-service';
import { getPushTargetStatesForEvents } from '@/lib/push/delivery';
import { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES } from '@/lib/job-status';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;
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
  reviewStatus: true,
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
  if (rawLimit == null || Number.isNaN(rawLimit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, rawLimit), MAX_LIMIT);
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
  const limit = clampCrawlLogLimit(params.limit ?? DEFAULT_LIMIT);

  // Articles + DiscardedItems + Job 用单次 $transaction，
  // 把跨查询的不一致窗口降到最小。
  const pushSettings = await readPushSettings();
  const technicalItems = await getTechnicalWorkQueue();
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
        take: limit,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: crawlLogArticleSelect,
      }),
      db.discardedItem.findMany({
        where: { source: { enabled: true, deletedAt: null } },
        take: limit,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
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
  // 普通流水线保持最近 limit 篇；技术待办不受时间窗口限制，并按 id 去重合并。
  const articles = Array.from(new Map(
    [...recentArticles, ...technicalArticles].map((article) => [article.id, article]),
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
  const latestCollectJobRaw = latestJobs.find((job) => job.type === 'full' || job.type === 'collect') ?? null;

  const activeJob = activeJobRaw ? toJobSnapshot(activeJobRaw) : null;
  const latestJob = latestJobRaw ? toJobSnapshot(latestJobRaw) : null;
  const latestCollectJob = latestCollectJobRaw ? toJobSnapshot(latestCollectJobRaw) : null;

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
      let lastRunItemsFound: number | undefined;
      let lastRunError: string | undefined;
      if (runResult) {
        const isWarning = runResult.error === '0 items parsed';
        lastRunStatus = isWarning ? 'warning' : runResult.success ? 'success' : 'failed';
        lastRunItemsFound = runResult.itemsFound;
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
        lastRunItemsFound,
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
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
      crawl: projection.crawl,
      process: projection.process,
      cluster: projection.cluster,
      ai: projection.ai,
      score: projection.ai === 'done' || businessAiSkipped ? a.score : null,
      anomalyLabels: [
        ...(a.isAd ? ['ad' as const] : []),
        ...(a.event && a.event.articleCount > 1 && !isRepresentative ? ['duplicate' as const] : []),
        ...((a.aiStatus === 'done'
          || (a.aiStatus === 'skipped' && (a.skipReason === '无具体事件' || a.skipReason === '多事件聚合稿')))
          && a.aiConfidence != null
          && a.aiConfidence < 70
          ? ['low-confidence' as const]
          : []),
      ],
      push: projection.push,
      skipReason,
      lastTime: a.updatedAt.getTime(),
      // P1-6: 推送/AI 重试时间，方便管理员判断"何时自动重试"
      pushRetryAt: projection.pushRetryAt ?? (a.event?.nextPushRetryAt ? a.event.nextPushRetryAt.toISOString() : null),
      processRetryAt: a.fetchStatus === 'failed' && a.nextFetchRetryAt ? a.nextFetchRetryAt.toISOString() : null,
      aiRetryAt: a.aiStatus === 'failed' && a.nextAiRetryAt ? a.nextAiRetryAt.toISOString() : null,
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
      reviewStatus: a.reviewStatus,
      isEventRepresentative: isRepresentative,
      isPublic: isRepresentative && a.event?.publicStatus === 'published',
    };
    group.articles.push(articleProgress);
  }

  for (const d of discarded) {
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
      const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bt - at;
    });
  }

  return {
    activeJob,
    latestJob,
    sources,
    fetchedAt: Date.now(),
    technicalTotal: visibleTechnicalItems.filter((item) => item.state === 'manual').length,
    autoRetryTotal: visibleTechnicalItems.filter((item) => item.state === 'auto_retry').length,
  };
}
