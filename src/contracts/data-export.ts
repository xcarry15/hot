import { z } from 'zod';

export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_DATE_FIELDS = ['createdAt', 'publishedAt', 'updatedAt'] as const;
export const EXPORT_REPRESENTATIVE_FILTERS = ['all', 'yes', 'no'] as const;
export const EXPORT_PUSH_FILTERS = ['all', 'yes', 'no'] as const;

const optionalDateText = z.string().trim().max(40).default('');
const idList = z.array(z.string().trim().min(1).max(100)).max(500).default([]);

export const exportFilterSchema = z.object({
  dateField: z.enum(EXPORT_DATE_FIELDS).default('createdAt'),
  from: optionalDateText,
  to: optionalDateText,
  sourceIds: idList,
  fetchStatuses: z.array(z.enum(['pending', 'fetched', 'failed'])).max(10).default([]),
  aiStatuses: z.array(z.enum(['pending', 'done', 'skipped', 'failed'])).max(10).default([]),
  clusterStatuses: z.array(z.enum(['pending', 'clustered', 'failed', 'needs_review'])).max(10).default([]),
  publicStatuses: z.array(z.enum(['unpublished', 'published', 'revoked'])).max(10).default([]),
  representative: z.enum(EXPORT_REPRESENTATIVE_FILTERS).default('all'),
  pushed: z.enum(EXPORT_PUSH_FILTERS).default('all'),
  eventId: z.string().trim().max(100).default(''),
  includeDiscarded: z.boolean().default(true),
});

export type ExportFilter = z.infer<typeof exportFilterSchema>;

export const DEFAULT_EXPORT_FILTER: ExportFilter = {
  dateField: 'createdAt',
  from: '',
  to: '',
  sourceIds: [],
  fetchStatuses: [],
  aiStatuses: [],
  clusterStatuses: [],
  publicStatuses: [],
  representative: 'all',
  pushed: 'all',
  eventId: '',
  includeDiscarded: true,
};

export const exportJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

export type ExportJobStatusValue = z.infer<typeof exportJobStatusSchema>;

export interface ExportJobDto {
  id: string;
  status: ExportJobStatusValue;
  filter: ExportFilter;
  snapshotAt: string;
  progressTotal: number;
  progressDone: number;
  progressErrors: number;
  currentSheet: string;
  currentItemLabel: string;
  fileName: string;
  fileSizeBytes: number | null;
  error: string;
  attempt: number;
  cancelRequestedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExportJobListResponse {
  jobs: ExportJobDto[];
}

export interface ExportJobResponse {
  job: ExportJobDto;
}
