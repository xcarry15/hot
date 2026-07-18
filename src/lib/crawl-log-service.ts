/**
 * Crawl Log snapshot 应用服务。
 *
 * `getCrawlLogSnapshot(limit)` 负责：
 *   - 在单个 `$transaction` 中读取 active jobs / latest jobs / articles / discarded items
 *     与推送设置（拆出事务外的设置读取，仅为避免阻断）；
 *   - 解析 Job.payload/result 的安全 JSON；
 *   - 复用 `@/lib/article-pipeline-status` 的纯投影（不许复制条件）；
 *   - 按 sourceId 分组并按 articles+discarded 数量降序排序。
 *
 * 设计约束：
 *   - 不依赖 Next.js Request / Response；
 *   - 不修改查询上限 500、Job 排序、Source 分组与 active/latest 语义；
 *   - Service 内部不出现 no-cache 之类的 HTTP 头，那是 Route 的职责。
 */
import { db } from '@/lib/db';
import { readPushSettings } from '@/lib/push/policy';
import {
  deriveSkipReason,
  projectArticleSteps,
  type ArticleStepInput,
  type PushThresholds,
} from '@/lib/article-pipeline-status';
import type { Job } from '@prisma/client';
import type {
  ArticleProgress,
  CrawlLogSnapshot,
  JobSnapshot,
  SourceProgress,
} from '@/contracts/crawl-log';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;
const ACTIVE_JOBS_LIMIT = 5;
const LATEST_JOBS_LIMIT = 5;

function safeJsonParse<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toJobSnapshot(job: Job): JobSnapshot {
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

/**
 * 取抓取记录页唯一权威快照：activeJob + latestJob + sources + fetchedAt。
 * 单进程全局单 Job 不变量下，activeJobs ≤ 1；多条时记服务端告警并稳定选择最新一条。
 */
export async function getCrawlLogSnapshot(
  params: GetCrawlLogSnapshotParams = {},
): Promise<CrawlLogSnapshot> {
  const limit = clampCrawlLogLimit(params.limit ?? DEFAULT_LIMIT);

  // Articles + DiscardedItems + Job 用单次 $transaction，
  // 把跨查询的不一致窗口降到最小。
  const pushSettings = await readPushSettings();

  const [activeJobs, latestJobs, articles, discarded, configuredSources = []] = await db.$transaction([
    db.job.findMany({
      where: { status: 'running' },
      orderBy: { createdAt: 'desc' },
      take: ACTIVE_JOBS_LIMIT,
    }),
    db.job.findMany({
      where: { status: { in: ['completed', 'failed'] } },
      orderBy: { completedAt: 'desc' },
      take: LATEST_JOBS_LIMIT,
    }),
    db.article.findMany({
      take: limit,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        publishedAt: true,
        sourceId: true,
        fetchStatus: true,
        aiStatus: true,
        score: true,
        eventScore: true,
        contentScore: true,
        rawScore: true,
        adProbability: true,
        aiConfidence: true,
        category: true,
         event: { select: { pushedAt: true, nextPushRetryAt: true } },
         nextAiRetryAt: true,
        relevance: true,
        createdAt: true,
        updatedAt: true,
        summary: true,
        skipReason: true,
        isAd: true,
        source: { select: { name: true } },
      },
    }),
    db.discardedItem.findMany({
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
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

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
        lastRunStatus = runResult.success ? 'success' : 'failed';
        lastRunItemsFound = runResult.itemsFound;
        lastRunError = runResult.error;
        status = runResult.success ? 'success' : 'error';
        error = runResult.error;
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

    const stepInput: ArticleStepInput = {
      fetchStatus: a.fetchStatus,
      aiStatus: a.aiStatus,
      score: a.score,
      relevance: a.relevance,
      eventPushedAt: a.event?.pushedAt ?? null,
      eventNextRetryAt: a.event?.nextPushRetryAt ?? null,
    };
    const projection = projectArticleSteps(stepInput, push);
    // P0-4: 不再应用全局阶段 overlay——没有 currentItemId 时伪造转圈会失真
    const hasScore = a.score > 0;

    const articleProgress: ArticleProgress = {
      id: a.id,
      title: a.title,
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
      crawl: projection.crawl,
      process: projection.process,
      ai: projection.ai,
      push: projection.push,
      aiScore: a.score || undefined,
      aiCategory: a.category || undefined,
      eventScore: hasScore ? (a.eventScore ?? undefined) : undefined,
      contentScore: hasScore ? (a.contentScore ?? undefined) : undefined,
      rawScore: hasScore ? (a.rawScore ?? undefined) : undefined,
      adProbability: hasScore ? (a.adProbability ?? undefined) : undefined,
      aiConfidence: hasScore ? (a.aiConfidence ?? undefined) : undefined,
      skipReason: deriveSkipReason({
        aiStatus: a.aiStatus,
        skipReason: a.skipReason,
        summary: a.summary,
      }),
      isAd: a.isAd,
      lastTime: a.updatedAt.getTime(),
      // P1-6: 推送/AI 重试时间，方便管理员判断"何时自动重试"
      pushRetryAt: projection.pushRetryAt ?? (a.event?.nextPushRetryAt ? a.event.nextPushRetryAt.toISOString() : null),
      aiRetryAt: a.aiStatus === 'failed' && a.nextAiRetryAt ? a.nextAiRetryAt.toISOString() : null,
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
    if (!bySource.has(sourceId)) {
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
  };
}
