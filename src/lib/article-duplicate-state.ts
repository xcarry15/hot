import type { Prisma } from '@prisma/client';
import type { DedupEvidence } from '@/lib/dedup-evidence';

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
  options: { dedupOverride?: boolean | 'preserve' } = {},
): Prisma.ArticleUpdateInput {
  return {
    aiStatus: 'pending',
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
    scorePolicyVersion: '',
    aiModel: '',
    aiProvider: '',
    promptHash: '',
    scorePolicySnapshot: '',
    promptVersion: 'v1',
    isAd: false,
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
