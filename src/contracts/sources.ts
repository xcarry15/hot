import type { SourceStatus, SourceType } from '@/lib/source-schema';

export type { SourceStatus, SourceType };

export interface SourceDto {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  parserConfig: string;
  enabled: boolean;
  status: SourceStatus;
  consecutiveFailures: number;
  circuitBreakerUntil: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  articleCount: number;
  recentErrors: { message: string; time: string }[];
}

export interface SourceTestResultDto {
  success: boolean;
  items: { title: string; url: string; summary?: string }[];
  error?: string;
}

export interface PresetSourceItemDto {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  parserConfig: string;
  category: string;
  description: string;
  isAdded: boolean;
}
