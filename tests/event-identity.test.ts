import { describe, expect, it } from 'vitest';
import {
  buildCanonicalEventKey,
  normalizeEventIdentity,
  normalizeEventSubjects,
} from '@/contracts/event-identity';

describe('事件键主体', () => {
  it('事件主体独立于展示品牌生成事件键', () => {
    const identity = normalizeEventIdentity({ subjects: '["瑞幸"]', action: '正式开店', object: '上海首店' });

    expect(identity.subjects).toEqual(['瑞幸']);
    expect(buildCanonicalEventKey(identity)).toBe('瑞幸/正式开店/上海首店');
  });

  it('将常见品牌别名归一为稳定事件主体', () => {
    expect(normalizeEventSubjects('["Costco"]')).toEqual(['Costco开市客']);
    expect(normalizeEventSubjects('["十足便利店"]')).toEqual(['十足便利']);
    expect(normalizeEventSubjects('["Eleven"]')).toEqual(['7-Eleven']);
  });
});
