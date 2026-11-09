// Display formatting. Numbers keep their unit in the label next to them; everything is UTC and en-US so the
// server and the browser print the same text.

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const dash = '—';

export const fmtInt = (n: number | null): string => (n === null ? dash : int.format(n));

/** A latency in milliseconds: "84 ms" under a second, "1.42 s" above. */
export function fmtMs(ms: number | null): string {
  if (ms === null) return dash;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${int.format(Math.round(ms))} ms`;
}

/** A 0..1 ratio as a percentage. */
export function fmtPct(r: number | null): string {
  if (r === null) return dash;
  const p = r * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(1) : p.toFixed(2)}%`;
}

/** Micro-USD (1 USD = 1,000,000) as dollars: cents above a dollar, four decimals below, so small spends are not shown as zero. */
export function fmtUsd(micros: number | null): string {
  if (micros === null) return dash;
  const usd = micros / 1_000_000;
  return usd >= 1 || usd === 0 ? `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${usd.toFixed(4)}`;
}

export const toUsd = (micros: number): number => micros / 1_000_000;

/** "14:05" for ranges inside two days, "Jun 15" beyond. */
export function fmtTick(t: number, stepMs: number): string {
  return stepMs >= 3_600_000 * 6 ? day.format(t) : stepMs >= 3_600_000 ? `${day.format(t)} ${hhmm(t)}` : hhmm(t);
}
export const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

/** "2032-06-15 12:30:04" in UTC. */
export const fmtStamp = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');
