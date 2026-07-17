import type { Prisma } from '@prisma/client';
import type { DedupEvidence } from '@/lib/dedup-evidence';
import { MANUAL_OVERRIDE_FIELDS, parseManualOverrides } from '@/lib/shared/article-calibration';

/** 统一生成重复文章状态，避免各去重阶段分别维护同一组字段。 */
export function buildDuplicateArticleData(
  reason: string,
  evidence: DedupEvidence,
): Prisma.ArticleUpdateInput {
  return {
    aiStatus: 'skipped',
    score: 0,
    skipReason: reason,
    dedupDetail: JSON.stringify(evidence),
    duplicateStatus: 'duplicate',
    duplicateOfId: evidence.matchedId ?? null,
  };
}

/**
 * AI 重新分析前清除旧结果、审计快照与重复状态，避免 pending 文章展示过期结论。
 */
export function buildAiResetData(
  options: { dedupOverride?: boolean | 'preserve'; preserveManualOverrides?: boolean } = {},
): Prisma.ArticleUpdateInput {
  return {
    aiStatus: 'pending',
    ...(options.preserveManualOverrides ? {} : {
      relevance: 0,
      summary: '',
      brand: '',
      category: '',
      tags: '[]',
      keyPoints: '[]',
      score: 0,
      eventScore: null,
      contentScore: null,
      rawScore: null,
      adProbability: null,
      aiConfidence: null,
      isAd: false,
      aiSnapshot: '{}',
      manualOverrides: '[]',
      manualCorrectedAt: null,
    }),
    scorePolicyVersion: '',
    aiModel: '',
    aiProvider: '',
    promptHash: '',
    scorePolicySnapshot: '',
    promptVersion: 'v1',
    aiRetryCount: 0,
    nextAiRetryAt: null,
    skipReason: null,
    dedupDetail: null,
    duplicateStatus: 'none',
    duplicateOfId: null,
    ...(options.dedupOverride === 'preserve'
      ? {}
      : { dedupOverride: options.dedupOverride ?? false }),
  };
}

/**
 * 按文章当前的人工覆盖字段生成重置数据：
 * - 未被人工覆盖的 AI 字段清空，避免重分析期间展示旧结论；
 * - 已被人工覆盖的字段保留，等待新 AI 结果与人工值合并；
 * - 总分仍清零，待新的事件分/内容分/广告规则完整后统一重算。
 */
export function buildAiResetDataForArticle(
  article: {
    manualOverrides: string | null;
    manualCorrectedAt?: Date | null;
    relevance: number;
    summary: string;
    brand: string;
    category: string;
    tags: string;
    keyPoints: string;
    eventScore: number | null;
    contentScore: number | null;
    adProbability: number | null;
    isAd: boolean;
  },
  options: { dedupOverride?: boolean | 'preserve' } = {},
): Prisma.ArticleUpdateInput {
  const data = buildAiResetData({ ...options, preserveManualOverrides: false });
  const overrides = new Set(parseManualOverrides(article.manualOverrides));
  const preserved: Record<string, unknown> = {};
  for (const field of MANUAL_OVERRIDE_FIELDS) {
    if (overrides.has(field)) {
      preserved[field] = article[field];
    }
  }
  Object.assign(data, preserved, {
    manualOverrides: article.manualOverrides || '[]',
    manualCorrectedAt: article.manualCorrectedAt ?? null,
  });
  return data;
}
