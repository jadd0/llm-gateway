// A budget period is a UTC calendar month, written 'YYYY-MM'.

export type Period = string;

export function periodOf(ms: number): Period {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const isPeriod = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Unix seconds at which a period's Redis keys expire: 35 days after the period starts. */
export function periodExpiryS(period: Period): number {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return Math.floor(Date.UTC(y, m - 1, 1) / 1000) + 35 * 86_400;
}
