export interface ScorePolicyResult {
  rawScore: number;
  finalScore: number;
  version: string;
}

export function buildScorePolicySnapshot(weightEvent: number, weightContent: number): string {
  return JSON.stringify({
    version: 'local-v9-expansion', weightEvent, weightContent,
    adFreeThreshold: 20, adPenaltyRate: 0.15, adHardThreshold: 70,
    lowEvidenceAdCap: 45, usefulAdCap: 70,
    contentBonus80: 2, contentBonus90: 4,
  });
}

/** 确定性评分策略：相关度只做推送资格门槛，不再重复影响总分。 */
export function applyScorePolicy(
  eventScore: number,
  contentScore: number,
  adProbability: number,
  isAd: boolean,
  weightEvent: number,
  weightContent: number,
): ScorePolicyResult {
  const totalWeight = weightEvent + weightContent;
  const rawScore = Math.max(0, Math.min(100, Math.round(
    totalWeight <= 0
      ? (eventScore + contentScore) / 2
      : (eventScore * weightEvent + contentScore * weightContent) / totalWeight,
  )));
  const normalizedAdProbability = Math.max(0, Math.min(100, Math.round(adProbability)));
  // 正常报道常有 5-20 的模型不确定性，不应因此被扣分；仅对明确可疑区间渐进惩罚。
  const adPenalty = normalizedAdProbability <= 20
    ? 0
    : Math.round((normalizedAdProbability - 20) * 0.15);
  // 证据完整度只做小幅修正，避免文笔/篇幅压过真正的拓展情报价值。
  const contentBonus = contentScore >= 90 ? 4 : contentScore >= 80 ? 2 : 0;
  const adjustedScore = Math.min(100, Math.max(0, rawScore + contentBonus - adPenalty));
  // 品牌自发信息也可能含有门店计划、人事任命等有效情报：有硬事实时允许进入关注池，
  // 纯宣传且证据薄弱时仍严格封顶。
  const adCap = eventScore >= 75 && contentScore >= 65 ? 70 : 45;
  const finalScore = isAd || normalizedAdProbability >= 70 ? Math.min(adCap, adjustedScore) : adjustedScore;

  return {
    rawScore,
    finalScore,
    version: `local-v9-expansion:e${weightEvent}-c${weightContent}`,
  };
}
