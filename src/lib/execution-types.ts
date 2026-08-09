import type { JOB_TYPE_VALUES } from '@/contracts/state';

export type JobType = (typeof JOB_TYPE_VALUES)[number];

export type JobExecutor = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
) => Promise<Record<string, unknown>>;

export type SingleWorkflowStart = 'process' | 'cluster' | 'ai' | 'push';
export type SingleWorkflowIntent = 'retry' | 'regenerate';
