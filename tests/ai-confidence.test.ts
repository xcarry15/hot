import { describe, expect, it } from 'vitest';
import { isLowAnalysisConfidence } from '@/contracts/ai-confidence';

describe('低分析置信判断', () => {
  it('只命中 AI 已完成且低于阈值的文章', () => {
    expect(isLowAnalysisConfidence({ aiStatus: 'done', aiConfidence: 69 })).toBe(true);
    expect(isLowAnalysisConfidence({ aiStatus: 'done', aiConfidence: 70 })).toBe(false);
    expect(isLowAnalysisConfidence({ aiStatus: 'skipped', aiConfidence: 20 })).toBe(false);
    expect(isLowAnalysisConfidence({ aiStatus: 'done', aiConfidence: null })).toBe(false);
  });
});
