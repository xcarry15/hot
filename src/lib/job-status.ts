import type { JobStatus } from '@prisma/client';

export const ALL_JOB_STATUSES = ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'completed'] as const satisfies readonly JobStatus[];
export const ACTIVE_JOB_STATUSES = ['running', 'cancel_requested'] as const satisfies readonly JobStatus[];
export const SUCCESS_JOB_STATUSES = ['succeeded', 'completed'] as const satisfies readonly JobStatus[];
export const TERMINAL_JOB_STATUSES = ['succeeded', 'completed', 'failed', 'cancelled'] as const satisfies readonly JobStatus[];
export const CLAIMABLE_JOB_STATUSES = ['queued'] as const satisfies readonly JobStatus[];

export function parseJobStatus(value: string | null): JobStatus | undefined {
  return value && ALL_JOB_STATUSES.includes(value as JobStatus) ? value as JobStatus : undefined;
}
