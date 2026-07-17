import type { Prisma } from '@prisma/client';
import { applyScorePolicy, buildScorePolicySnapshot } from '@/lib/score-policy';
import {
  parseArticleAiSnapshot as parseSharedArticleAiSnapshot,
  parseManualOverrides,
  type ManualOverrideField,
} from '@/lib/shared/article-calibration';

export { MANUAL_OVERRIDE_FIELDS, parseManualOverrides, type ManualOverrideField } from '@/lib/shared/article-calibration';

export interface ArticleAiSnapshot {
  relevance: number;
  summary: string;
  brand: string;
  category: string;
  tags: string;
  keyPoints: string;
  score: number;
  eventScore: number;
  contentScore: number;
  rawScore: number;
  adProbability: number;
  aiConfidence: number;
  isAd: boolean;
  model: string;
  provider: string;
  promptHash: string;
  promptVersion: string;
}

export type ManualCalibrationValues = Pick<ArticleAiSnapshot, ManualOverrideField>;

export function parseArticleAiSnapshot(value: string | null | undefined): Partial<ArticleAiSnapshot> {
  return parseSharedArticleAiSnapshot(value) as Partial<ArticleAiSnapshot>;
}

export function getSnapshotValue(
  value: string | null | undefined,
  field: ManualOverrideField,
): string | number | boolean | undefined {
  return parseArticleAiSnapshot(value)[field];
}

export function buildArticleAiSnapshot(input: ArticleAiSnapshot): string {
  return JSON.stringify(input);
}

export function mergeAiResultWithManualOverrides(
  ai: ArticleAiSnapshot,
  current: ManualCalibrationValues,
  manualOverrides: string | null | undefined,
): ArticleAiSnapshot {
  const overrides = new Set(parseManualOverrides(manualOverrides));
  return {
    ...ai,
    relevance: overrides.has('relevance') ? current.relevance : ai.relevance,
    summary: overrides.has('summary') ? current.summary : ai.summary,
    brand: overrides.has('brand') ? current.brand : ai.brand,
    category: overrides.has('category') ? current.category : ai.category,
    tags: overrides.has('tags') ? current.tags : ai.tags,
    keyPoints: overrides.has('keyPoints') ? current.keyPoints : ai.keyPoints,
    eventScore: overrides.has('eventScore') ? current.eventScore : ai.eventScore,
    contentScore: overrides.has('contentScore') ? current.contentScore : ai.contentScore,
    adProbability: overrides.has('adProbability') ? current.adProbability : ai.adProbability,
    isAd: overrides.has('isAd') ? current.isAd : ai.isAd,
  };
}

export function buildManualOverrideUpdate(
  current: string | null | undefined,
  touched: ManualOverrideField[],
  restored: ManualOverrideField[] = [],
): Pick<Prisma.ArticleUpdateInput, 'manualOverrides' | 'manualCorrectedAt'> {
  const fields = new Set(parseManualOverrides(current));
  for (const field of touched) fields.add(field);
  for (const field of restored) fields.delete(field);
  return {
    manualOverrides: JSON.stringify([...fields]),
    manualCorrectedAt: fields.size > 0 ? new Date() : null,
  };
}

export function buildEffectiveScoreUpdate(input: {
  eventScore: number;
  contentScore: number;
  adProbability: number;
  isAd: boolean;
  weightEvent: number;
  weightContent: number;
}): Pick<Prisma.ArticleUpdateInput, 'score' | 'rawScore' | 'scorePolicyVersion' | 'scorePolicySnapshot'> {
  const policy = applyScorePolicy(
    input.eventScore,
    input.contentScore,
    input.adProbability,
    input.isAd,
    input.weightEvent,
    input.weightContent,
  );
  return {
    score: policy.finalScore,
    rawScore: policy.rawScore,
    scorePolicyVersion: policy.version,
    scorePolicySnapshot: buildScorePolicySnapshot(input.weightEvent, input.weightContent),
  };
}
