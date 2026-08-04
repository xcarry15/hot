/** AI 整篇结构化分析低于该值时进入人工复核。 */
export const AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD = 70;

/**
 * 低分析置信只描述“AI 已完成，但证据把握不足”的文章。
 * 业务跳过（例如无价值）属于独立结论，不应混入该队列。
 */
export const LOW_ANALYSIS_CONFIDENCE_FILTER = {
  aiStatus: 'done' as const,
  aiConfidence: { lt: AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD },
};

export function isLowAnalysisConfidence(input: {
  aiStatus: string;
  aiConfidence: number | null | undefined;
}): boolean {
  return input.aiStatus === LOW_ANALYSIS_CONFIDENCE_FILTER.aiStatus
    && input.aiConfidence != null
    && input.aiConfidence < AI_ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD;
}
