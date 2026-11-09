import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const env = (extra: Record<string, string>) => ({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  API_KEY_PEPPER: 'x'.repeat(40),
  ...extra,
});

describe('budget settings', () => {
  it('a reservation TTL that does not outlast the longest upstream call plus 30 s stops the gateway starting', () => {
    // The longest a call can last is UPSTREAM_MAX_DURATION_MS; its hold needs 30 s more to be settled in.
    const bad = { BUDGET_RESERVATION_TTL_S: '270', UPSTREAM_MAX_DURATION_MS: '240000' };
    expect(() => loadConfig(env(bad))).toThrow(/BUDGET_RESERVATION_TTL_S must be longer than UPSTREAM_MAX_DURATION_MS/);
    expect(() => loadConfig(env({ BUDGET_RESERVATION_TTL_S: '5', UPSTREAM_MAX_DURATION_MS: '240000' }))).toThrow();
    expect(loadConfig(env({ BUDGET_RESERVATION_TTL_S: '271', UPSTREAM_MAX_DURATION_MS: '240000' })).budgetReservationTtlS).toBe(271);
    // The idle timeout is not what the hold must outlast.
    expect(loadConfig(env({ UPSTREAM_TIMEOUT_MS: '600000' })).upstreamTimeoutMs).toBe(600_000);
    // Budgets off: nothing to hold, nothing to check.
    expect(loadConfig(env({ BUDGET_ENABLED: 'false', BUDGET_RESERVATION_TTL_S: '1' })).budgetEnabled).toBe(false);
    // The default total deadline is covered by the default hold.
    expect(loadConfig(env({}))).toMatchObject({ upstreamMaxDurationMs: 240_000, budgetReservationTtlS: 300 });
  });

  it('defaults, and the monthly cap is read as exact micro-USD', () => {
    const c = loadConfig(env({}));
    expect(c).toMatchObject({ budgetEnabled: true, budgetReservationTtlS: 300, budgetOutageFailures: 3, budgetDefaultMonthlyMicros: 10_000_000 });
    expect(loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '0.000001' })).budgetDefaultMonthlyMicros).toBe(1);
    expect(() => loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '1e3' }))).toThrow();
  });
});
