import { z } from 'zod';

export const JOB_TYPE_VALUES = ['full', 'collect', 'process', 'ai', 'cluster', 'push', 'maintenance'] as const;
export const JOB_TYPE_CODEC = z.enum(JOB_TYPE_VALUES);
export type JobTypeValue = z.infer<typeof JOB_TYPE_CODEC>;

export const AI_STATUS_VALUES = ['pending', 'done', 'failed', 'skipped'] as const;
export const AI_STATUS_CODEC = z.enum(AI_STATUS_VALUES);
export type AIStatus = z.infer<typeof AI_STATUS_CODEC>;

export const FETCH_STATUS_VALUES = ['pending', 'fetched', 'failed'] as const;
export const FETCH_STATUS_CODEC = z.enum(FETCH_STATUS_VALUES);
export type FetchStatusValue = z.infer<typeof FETCH_STATUS_CODEC>;

export const CLUSTER_STATUS_VALUES = ['pending', 'clustered', 'failed', 'needs_review'] as const;
export const CLUSTER_STATUS_CODEC = z.enum(CLUSTER_STATUS_VALUES);
export type ClusterStatus = z.infer<typeof CLUSTER_STATUS_CODEC>;

export const PUBLIC_STATUS_VALUES = ['unpublished', 'published', 'revoked'] as const;
export const PUBLIC_STATUS_CODEC = z.enum(PUBLIC_STATUS_VALUES);
export type PublicStatus = z.infer<typeof PUBLIC_STATUS_CODEC>;

export const PUBLIC_OVERRIDE_VALUES = ['auto', 'public', 'hidden'] as const;
export const PUBLIC_OVERRIDE_CODEC = z.enum(PUBLIC_OVERRIDE_VALUES);
export type PublicOverride = z.infer<typeof PUBLIC_OVERRIDE_CODEC>;

export const EVENT_STATUS_VALUES = ['active', 'merged'] as const;
export const EVENT_STATUS_CODEC = z.enum(EVENT_STATUS_VALUES);
export type EventStatus = z.infer<typeof EVENT_STATUS_CODEC>;

export const EVENT_REVIEW_STATUS_VALUES = ['confirmed', 'pending'] as const;
export const EVENT_REVIEW_STATUS_CODEC = z.enum(EVENT_REVIEW_STATUS_VALUES);
export type EventReviewStatus = z.infer<typeof EVENT_REVIEW_STATUS_CODEC>;

/** 公开统计口径：一次通过 800ms 观察确认的浏览请求计为 1 次，不代表去重访客数。 */
export const PUBLIC_INTERACTION_METRIC = 'confirmed_request_count' as const;

export const JSON_OBJECT_CODEC = z.record(z.string(), z.unknown());
export const JSON_ARRAY_CODEC = z.array(z.unknown());

export type JsonObject = z.infer<typeof JSON_OBJECT_CODEC>;
export type JsonArray = z.infer<typeof JSON_ARRAY_CODEC>;

export function parseJsonObject(value: string | null | undefined): JsonObject | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = JSON_OBJECT_CODEC.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseJsonArray(value: string | null | undefined): JsonArray | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = JSON_ARRAY_CODEC.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
