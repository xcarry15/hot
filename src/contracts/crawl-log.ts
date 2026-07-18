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

export interface ArticleProgress {
  id: string;
  title: string;
  publishedAt?: string | null;
  crawl: StepStatus;
  process: StepStatus;
  cluster: StepStatus;
  ai: StepStatus;
  /** AI 完成后的最终有效评分；未完成时为 null。 */
  score: number | null;
  push: StepStatus;
  skipReason?: string;
  lastTime: number;
  /** P1-6: 推送失败后的重试时间 */
  pushRetryAt?: string | null;
  /** P1-6: AI 失败后的下次重试时间 */
  aiRetryAt?: string | null;
  clusterStatus: 'pending' | 'clustered' | 'failed' | 'needs_review';
  clusterRetryAt?: string | null;
  technicalIssues: Array<'process_failed' | 'cluster_failed' | 'ai_failed' | 'push_failed'>;
  isEventRepresentative: boolean;
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
  /** 最近一次采集运行中发现的条目数（来自 FetchLog/Job result） */
  lastRunItemsFound?: number;
  /** 最近一次采集运行的错误信息 */
  lastRunError?: string;
}

export type JobType = 'full' | 'collect' | 'process' | 'cluster' | 'ai' | 'push' | 'fastProcess';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type JobStage = 'collect' | 'process' | 'cluster' | 'ai' | 'push';

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
  sources: SourceProgress[];
  fetchedAt: number;
  technicalTotal: number;
}

export interface CrawlLogJobStatusSnapshot {
  activeJob: JobSnapshot | null;
  latestJob: JobSnapshot | null;
  fetchedAt: number;
}
