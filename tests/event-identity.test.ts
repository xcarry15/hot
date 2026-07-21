import { describe, expect, it } from 'vitest';
import {
  buildCanonicalEventKey,
  normalizeEventIdentity,
  resolveEventKeySubjects,
} from '@/contracts/event-identity';

describe('事件键主体', () => {
  it('有品牌时直接复用品牌，避免品牌与事件主体出现两套值', () => {
    const subjects = resolveEventKeySubjects('["瑞幸咖啡"]', '["瑞幸"]');
    const identity = normalizeEventIdentity({ subjects, action: '正式开店', object: '上海首店' });

    expect(identity.subjects).toEqual(['瑞幸咖啡']);
    expect(buildCanonicalEventKey(identity)).toBe('瑞幸咖啡/正式开店/上海首店');
  });

  it('无品牌时保留非品牌事件的直接主体', () => {
    expect(resolveEventKeySubjects('[]', '["市场监管局"]')).toEqual(['市场监管局']);
  });
});
