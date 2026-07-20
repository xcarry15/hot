import { describe, expect, it } from 'vitest';
import { applyScorePolicy } from '@/lib/score-policy';

describe('关键词特殊加分', () => {
  it('只对真实命中的文章在最终分上追加', () => {
    const plain = applyScorePolicy(70, 70, 0, false, 75, 25, false, 5);
    const matched = applyScorePolicy(70, 70, 0, false, 75, 25, true, 5);
    expect(matched.finalScore).toBe(plain.finalScore + 5);
    expect(matched.rawScore).toBe(plain.rawScore);
  });

  it('软文封顶后仍可获得特殊加分，但总分不超过 100', () => {
    expect(applyScorePolicy(90, 90, 90, true, 75, 25, true, 5).finalScore).toBe(75);
    expect(applyScorePolicy(100, 100, 0, false, 75, 25, true, 20).finalScore).toBe(100);
  });
});
