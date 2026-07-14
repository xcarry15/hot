import { describe, expect, it } from 'vitest';
import { normalizePositiveInt, parsePositiveInt } from '@/lib/pagination';

describe('pagination input boundary', () => {
  it('仅接受完整的正整数，非法值回退，超限值封顶', () => {
    expect(parsePositiveInt(null, 20, 100)).toBe(20);
    expect(parsePositiveInt('NaN', 20, 100)).toBe(20);
    expect(parsePositiveInt('-1', 20, 100)).toBe(20);
    expect(parsePositiveInt('1.5', 20, 100)).toBe(20);
    expect(parsePositiveInt('2oops', 20, 100)).toBe(20);
    expect(parsePositiveInt('999', 20, 100)).toBe(100);
    expect(normalizePositiveInt(Number.NaN, 20)).toBe(20);
  });
});
