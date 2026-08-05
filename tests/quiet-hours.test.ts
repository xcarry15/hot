import { describe, expect, it } from 'vitest';
import { getQuietHoursEndAt, isWithinQuietHours } from '@/lib/quiet-hours';

function atUtc(iso: string): Date {
  return new Date(iso);
}

describe('quiet hours', () => {
  it('supports a cross-midnight window such as 22:00-08:00', () => {
    expect(isWithinQuietHours(atUtc('2026-08-04T13:59:00.000Z'), '22:00', '08:00')).toBe(false); // 21:59
    expect(isWithinQuietHours(atUtc('2026-08-04T14:00:00.000Z'), '22:00', '08:00')).toBe(true); // 22:00
    expect(isWithinQuietHours(atUtc('2026-08-04T18:00:00.000Z'), '22:00', '08:00')).toBe(true); // 02:00
    expect(isWithinQuietHours(atUtc('2026-08-04T23:59:00.000Z'), '22:00', '08:00')).toBe(true); // 07:59
    expect(isWithinQuietHours(atUtc('2026-08-05T00:00:00.000Z'), '22:00', '08:00')).toBe(false); // 08:00
  });

  it('supports a same-day window and treats invalid/equal values as disabled', () => {
    expect(isWithinQuietHours(atUtc('2026-08-05T00:00:00.000Z'), '08:00', '22:00')).toBe(true); // 08:00
    expect(isWithinQuietHours(atUtc('2026-08-05T13:59:00.000Z'), '08:00', '22:00')).toBe(true); // 21:59
    expect(isWithinQuietHours(atUtc('2026-08-05T14:00:00.000Z'), '08:00', '22:00')).toBe(false); // 22:00
    expect(isWithinQuietHours(atUtc('2026-08-05T02:00:00.000Z'), '08:00', '08:00')).toBe(false);
    expect(isWithinQuietHours(atUtc('2026-08-05T02:00:00.000Z'), 'bad', '08:00')).toBe(false);
  });

  it('calculates the next quiet-hour end across midnight in Shanghai time', () => {
    expect(getQuietHoursEndAt(atUtc('2026-08-04T18:00:00.000Z'), '22:00', '08:00')?.toISOString())
      .toBe('2026-08-05T00:00:00.000Z'); // 上海 02:00 → 当天 08:00
    expect(getQuietHoursEndAt(atUtc('2026-08-04T14:00:00.000Z'), '22:00', '08:00')?.toISOString())
      .toBe('2026-08-05T00:00:00.000Z'); // 上海 22:00 → 次日 08:00
    expect(getQuietHoursEndAt(atUtc('2026-08-05T00:00:00.000Z'), '22:00', '08:00')).toBeNull();
  });
});
