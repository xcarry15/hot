import type { Prisma } from '@prisma/client';
import { MANUAL_OVERRIDE_FIELDS, parseManualOverrides } from '@/lib/shared/article-calibration';

/**
 * AI 重新分析前清除旧结果与审计快照，避免 pending 文章展示过期结论。
 */
export function buildAiResetData(options: { preserveManualOverrides?: boolean } = {}): Prisma.ArticleUpdateInput {
  return {
    aiStatus: 'pending',
    ...(options.preserveManualOverrides ? {} : {
      relevance: 0,
      summary: '',
      brand: '',
      category: '',
      eventSubjects: '[]',
      eventAction: '',
      eventObject: '',
      eventKey: '',
      eventKeyConfidence: null,
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
    eventSubjects: string;
    eventAction: string;
    eventObject: string;
    keyPoints: string;
    eventScore: number | null;
    contentScore: number | null;
    adProbability: number | null;
    isAd: boolean;
  },
): Prisma.ArticleUpdateInput {
  const data = buildAiResetData({ preserveManualOverrides: false });
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
