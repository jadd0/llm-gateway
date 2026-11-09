import { describe, expect, it } from 'vitest';
import { isPeriod, periodExpiryS, periodOf } from './period.ts';

describe('period', () => {
  it('rolls over at the UTC month boundary', () => {
    expect(periodOf(Date.UTC(2026, 10, 30, 23, 59, 59, 999))).toBe('2026-11');
    expect(periodOf(Date.UTC(2026, 11, 1, 0, 0, 0, 0))).toBe('2026-12');
    expect(periodOf(Date.UTC(2027, 0, 1, 0, 0, 0, 0))).toBe('2027-01');
    // 23:30 on 31 Dec in UTC-1 is already January in UTC.
    expect(periodOf(Date.parse('2026-12-31T23:30:00-01:00'))).toBe('2027-01');
  });

  it('expires keys 35 days after the period starts', () => {
    expect(periodExpiryS('2026-11')).toBe(Date.UTC(2026, 10, 1) / 1000 + 35 * 86_400);
  });

  it('recognises well-formed periods only', () => {
    expect(['2026-11', '1999-01', '2026-12'].every(isPeriod)).toBe(true);
    expect(['2026-13', '2026-00', '26-11', '2026-1', ''].some(isPeriod)).toBe(false);
  });
});
