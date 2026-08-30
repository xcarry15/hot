/**
 * Crawl Log snapshot 的纯 JSON 契约。
 *
 * 本文件不得导入 Prisma、React、数据库或浏览器运行时模块。
 */
export type StepStatus =
  | 'done'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'filtered'
  | 'not_applicable'
  | 'running';

/** 工作台只展示最近采集窗口，历史文章通过文章库服务端分页查询。 */
export const CRAWL_LOG_DEFAULT_LIMIT = 400;
export const CRAWL_LOG_MAX_LIMIT = 500;

export interface ArticleProgress {
  id: string;
  title: string;
  /** 文章进入系统的时间；工作台窗口按此时间截取，列表优先按 publishedAt 排序。 */
  createdAt: string;
  publishedAt?: string | null;
  crawl: StepStatus;
  process: StepStatus;
  cluster: StepStatus;
  ai: StepStatus;
  /** AI 完成分析后的最终有效评分；业务正常跳过文章也保留评分，技术未完成时为 null。 */
  score: number | null;
  /** 仅用于列表标题后的轻量异常标签，不暴露 AI 分析明细。 */
  anomalyLabels: Array<'ad' | 'duplicate' | 'low-confidence' | 'filtered'>;
  push: StepStatus;
  skipReason?: string;
  /** 工作台时间列使用文章首次采集入库时间（createdAt），而非会被流水线更新刷新的 updatedAt。 */
  lastTime: number;
  /** P1-6: 推送失败后的重试时间 */
  pushRetryAt?: string | null;
  /** P1-6: AI 失败后的下次重试时间 */
  aiRetryAt?: string | null;
  /** 正文处理失败后的下次自动重试时间 */
  processRetryAt?: string | null;
  clusterStatus: 'pending' | 'clustered' | 'failed' | 'needs_review';
  clusterRetryAt?: string | null;
  technicalIssues: Array<'process_failed' | 'ai_failed' | 'ai_waiting' | 'cluster_failed' | 'push_failed'>;
  technicalState?: 'auto_retry' | 'waiting' | 'manual' | 'ignored' | null;
  technicalIgnoredAt?: string | null;
  /** 当前技术失败的可展示原因，按步骤键保存。 */
  technicalErrorReasons: Partial<Record<'process' | 'ai' | 'cluster' | 'push', string>>;
  /** 当前 Event 的成员文章总数；未进入 Event 时为空。 */
  eventArticleCount?: number | null;
  isEventRepresentative: boolean;
  /** 当前 Event 的代表文章已处于公开状态。 */
  isPublic: boolean;
}

export interface DiscardedRow {
  id: string;
  title: string;
  url?: string;
  reason: string;
  detail?: Record<string, unknown> | null;
  publishedAt?: string | null;
  createdAt?: string;
}

export interface SourceProgress {
  id: string;
  name: string;
  status: 'running' | 'success' | 'error' | 'warning' | 'not-run';
  articles: ArticleProgress[];
  discarded: DiscardedRow[];
  deduped: number;
  filtered: number;
  itemsFound: number;
  error?: string;
  expanded: boolean;
  /** 最近一次采集运行的状态（来源于 Job result，非从 articles 推导） */
  lastRunStatus?: 'success' | 'warning' | 'failed' | 'not-run';
  /** 最近一次采集运行中实际新建的 Article 数量（不含重复和已丢弃条目） */
  lastRunNewArticles?: number;
  /** 最近一次采集运行的错误信息 */
  lastRunError?: string;
}

export type JobType = 'full' | 'collect' | 'process' | 'ai' | 'cluster' | 'push' | 'maintenance';
export type JobStatus = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'completed';
export type JobStage = 'collect' | 'process' | 'ai' | 'cluster' | 'push';

/** 工作台顶部的自动化运行真相；只保留管理员下一步判断所需的事实。 */
export interface CrawlRuntimeStatus {
  lastCrawlAt: string | null;
  lastCrawlCount: number | null;
  nextCrawlAt: string | null;
}

export interface JobSnapshot {
  id: string;
  type: JobType;
  status: JobStatus;
  currentStage: JobStage | null;
  progressTotal: number;
  progressDone: number;
  progressErrors: number;
  currentItemLabel: string;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string;
  result: Record<string, unknown> | null;
  /** 单篇文章工作流的目标文章；批量 Job 为 null。 */
  activeArticleId: string | null;
  /** Job 刚入队、currentStage 尚未写入时的起始阶段。 */
  workflowStartAt: JobStage | null;
}

export interface CrawlLogSnapshot {
  activeJob: JobSnapshot | null;
  latestJob: JobSnapshot | null;
  runtime?: CrawlRuntimeStatus;
  sources: SourceProgress[];
  fetchedAt: number;
  /** 本次普通文章窗口是否还有未返回的历史文章。 */
  hasMoreArticles: boolean;
  /** 未入库记录独立窗口是否还有未返回的历史记录。 */
  hasMoreDiscarded: boolean;
  technicalTotal: number;
  autoRetryTotal?: number;
}

export interface CrawlLogJobStatusSnapshot {
  activeJob: JobSnapshot | null;
  latestJob: JobSnapshot | null;
  fetchedAt: number;
}
