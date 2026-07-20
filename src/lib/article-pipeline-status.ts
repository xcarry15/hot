/**
 * 文章流水线状态投影（重构 #4）。
 *
 * 目的：消除 /api/crawl-log/status 与前端各组件对"步骤状态"的多套独立推断。
 * 此模块是唯一权威实现，任何路由 / 前端组件需要给出 crawl/process/ai/cluster/push
 * 的显示状态时，都必须调用 projectArticleSteps()，不得重新发明条件。
 *
 * 投影规则冻结（见重构报告 12.6）。任何调整都需要同步更新 push.ts 的 pushableWhere
 * 并测试覆盖。
 */

import type { FetchStatus } from '@prisma/client';
import type { PushMode } from '@/contracts/push';

export type StepStatus =
  | 'done'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'filtered'
  | 'not_applicable';

export type ArticleStepKey = 'crawl' | 'process' | 'ai' | 'cluster' | 'push';

/** 与前端 types.ts 兼容：'running' 仅用于 UI 动画层，DB 投影不带此状态。 */
export type DisplayStepStatus = StepStatus | 'running';

export interface PushThresholds {
  pushMode: PushMode;
  minScore: number;
  minRelevance: number;
  /** 当前时间快照——避免同一篇文章在多次投影中结果不一致 */
  now: Date;
}

/**
 * 输入形状：仅含各步骤投影所需的 Article 列。
 * 故意只列投影必需字段；调用方在 DB 投影时只 select 这些列，避免把 articles 表全部 select。
 */
export interface ArticleStepInput {
  fetchStatus: FetchStatus;
  clusterStatus: string;
  aiStatus: string;
  score: number;
  relevance: number;
  eventPushedAt: Date | null;
  eventNextRetryAt: Date | null;
  pushFailed?: boolean;
  pushApplicable?: boolean;
}

export interface ArticleStepProjection {
  crawl: StepStatus;
  process: StepStatus;
  cluster: StepStatus;
  ai: StepStatus;
  push: StepStatus;
  /** push='failed' 时附带 retryAt，方便前端显示。其它情况为 null。 */
  pushRetryAt?: string | null;
  /** 该文章是否处于"进行中"——任一步骤尚未到终态且不是终态失败/跳过/过滤/不适用的语义。 */
  isInProgress: boolean;
}

/**
 * 投影单一篇文章。
 *
 * 规则（来自重构报告 12.6）：
 * - crawl：Article 行存在 → done
 * - process：fetched → done；failed → failed；pending → pending
 * - ai：process 未完成 → blocked；aiStatus=done → done；skipped → skipped；failed → failed；其它 → pending
 * - cluster：AI 未完成 → blocked；clustered/needs_review → done；failed → failed；其它 → pending
 * - push：
 *   - pushedAt != null → done
 *   - process/AI 尚未完成 → blocked
 *   - AI 是 skipped/failed → not_applicable
 *   - push_mode='off' → not_applicable
 *   - AI 已完成但 score/relevance 低于阈值 → filtered
 *   - nextRetryAt > now → failed（同时返回 retryAt）
 *   - 满足条件且未推送 → pending
 *
 * 推送资格的判断必须复用 push.ts 的 where 条件语义（pushedAt=null / aiStatus=done /
 * score/relevance ≥ 阈值 / nextRetryAt 已到期），不允许本模块与 push.ts 演化分叉。
 */
export function projectArticleSteps(
  article: ArticleStepInput,
  push: PushThresholds,
): ArticleStepProjection {
  const crawl: StepStatus = 'done';

  const process: StepStatus =
    article.fetchStatus === 'fetched' ? 'done'
    : article.fetchStatus === 'failed' ? 'failed'
    : 'pending';

  let ai: StepStatus;
  if (process !== 'done') {
    ai = 'blocked';
  } else if (article.aiStatus === 'done') {
    ai = 'done';
  } else if (article.aiStatus === 'skipped') {
    ai = 'skipped';
  } else if (article.aiStatus === 'failed') {
    ai = 'failed';
  } else {
    ai = 'pending';
  }

  let cluster: StepStatus;
  if (ai !== 'done') {
    cluster = ai === 'failed' || ai === 'skipped' ? 'not_applicable' : 'blocked';
  } else if (article.clusterStatus === 'clustered' || article.clusterStatus === 'needs_review') {
    cluster = 'done';
  } else if (article.clusterStatus === 'failed') {
    cluster = 'failed';
  } else {
    cluster = 'pending';
  }

  let pushStatus: StepStatus = 'pending';
  let pushRetryAt: string | null = null;

  if (article.pushApplicable === false) {
    pushStatus = 'not_applicable';
  } else if (article.pushFailed) {
    pushStatus = 'failed';
    pushRetryAt = article.eventNextRetryAt?.toISOString() ?? null;
  } else if (article.eventPushedAt) {
    pushStatus = 'done';
  } else if (article.clusterStatus === 'needs_review') {
    pushStatus = 'blocked';
  } else if (ai === 'skipped' || ai === 'failed') {
    pushStatus = 'not_applicable';
  } else if (ai !== 'done' || cluster !== 'done') {
    pushStatus = 'blocked';
  } else if (push.pushMode === 'off') {
    pushStatus = 'not_applicable';
  } else if (article.score < push.minScore || article.relevance < push.minRelevance) {
    pushStatus = 'filtered';
  } else if (article.eventNextRetryAt && article.eventNextRetryAt > push.now) {
    pushStatus = 'failed';
    pushRetryAt = article.eventNextRetryAt.toISOString();
  } else {
    pushStatus = 'pending';
  }

  const isInProgress = (() => {
    const stepHasOpen = (s: StepStatus) =>
      s === 'pending' || s === 'blocked';
    return stepHasOpen(process) || stepHasOpen(ai) || stepHasOpen(cluster) || stepHasOpen(pushStatus);
  })();

  return { crawl, process, cluster, ai, push: pushStatus, pushRetryAt, isInProgress };
}

/**
 * 把投影结果映射到前端显示所需的 DisplayStepStatus。
 * 在 active Job 影响下，对当前阶段把 'pending' 升格为 'running'，用于动画。
 *
 * 投影函数本身不感知 Job；这是为了让 DB 投影成为单一事实源，
 * 而"running"仅作为 UI 动画提示，由组件层在 activeJob 已知时叠加。
 */
export function withRunningOverlay(
  projection: ArticleStepProjection,
  activeStage: ArticleStepKey | null,
): {
  crawl: DisplayStepStatus;
  process: DisplayStepStatus;
  cluster: DisplayStepStatus;
  ai: DisplayStepStatus;
  push: DisplayStepStatus;
} {
  const overlay = (step: ArticleStepKey, status: StepStatus): DisplayStepStatus => {
    if (activeStage === step && status === 'pending') return 'running';
    return status;
  };
  return {
    crawl: overlay('crawl', projection.crawl),
    process: overlay('process', projection.process),
    cluster: overlay('cluster', projection.cluster),
    ai: overlay('ai', projection.ai),
    push: overlay('push', projection.push),
  };
}

/**
 * 列表用的 skipReason 派生——把 aiStatus=skipped 翻译为可显示原因。
 * 仅在 status route 的最终组装里调用，不属于核心投影规则。
 */
export function deriveSkipReason(article: {
  aiStatus: string;
  skipReason: string | null;
  summary: string;
}): string | undefined {
  if (article.aiStatus === 'skipped') {
    return article.skipReason || article.summary || '内容不足';
  }
  return undefined;
}
