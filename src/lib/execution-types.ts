export type JobType = 'full' | 'collect' | 'process' | 'ai' | 'cluster' | 'push';

export type JobExecutor = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  jobId?: string,
) => Promise<Record<string, unknown>>;

export type SingleWorkflowStart = 'process' | 'cluster' | 'ai' | 'push';
export type SingleWorkflowIntent = 'retry' | 'regenerate';
