import { z } from 'zod';

export const JOB_TYPE_VALUES = ['full', 'collect', 'process', 'ai', 'cluster', 'push', 'maintenance'] as const;
export const JOB_TYPE_CODEC = z.enum(JOB_TYPE_VALUES);

export const AI_STATUS_VALUES = ['pending', 'done', 'failed', 'skipped'] as const;
export const AI_STATUS_CODEC = z.enum(AI_STATUS_VALUES);

export const FETCH_STATUS_VALUES = ['pending', 'fetched', 'failed'] as const;
export const FETCH_STATUS_CODEC = z.enum(FETCH_STATUS_VALUES);

export const CLUSTER_STATUS_VALUES = ['pending', 'clustered', 'failed', 'needs_review'] as const;
export const CLUSTER_STATUS_CODEC = z.enum(CLUSTER_STATUS_VALUES);

export const JSON_OBJECT_CODEC = z.record(z.string(), z.unknown());

export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = JSON_OBJECT_CODEC.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
