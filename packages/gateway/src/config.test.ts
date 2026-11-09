import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const env = (extra: Record<string, string>) => ({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  API_KEY_PEPPER: 'x'.repeat(40),
  ...extra,
});

describe('budget settings', () => {
  it('a reservation TTL that does not outlast the upstream timeout stops the gateway starting', () => {
    expect(() => loadConfig(env({ BUDGET_RESERVATION_TTL_S: '30', UPSTREAM_TIMEOUT_MS: '30000' }))).toThrow(
      /BUDGET_RESERVATION_TTL_S must be longer than UPSTREAM_TIMEOUT_MS/,
    );
    expect(() => loadConfig(env({ BUDGET_RESERVATION_TTL_S: '5', UPSTREAM_TIMEOUT_MS: '30000' }))).toThrow();
    expect(loadConfig(env({ BUDGET_RESERVATION_TTL_S: '31', UPSTREAM_TIMEOUT_MS: '30000' })).budgetReservationTtlS).toBe(31);
    // Budgets off: nothing to hold, nothing to check.
    expect(loadConfig(env({ BUDGET_ENABLED: 'false', BUDGET_RESERVATION_TTL_S: '1', UPSTREAM_TIMEOUT_MS: '30000' })).budgetEnabled).toBe(false);
  });

  it('defaults, and the monthly cap is read as exact micro-USD', () => {
    const c = loadConfig(env({}));
    expect(c).toMatchObject({ budgetEnabled: true, budgetReservationTtlS: 300, budgetOutageFailures: 3, budgetDefaultMonthlyMicros: 10_000_000 });
    expect(loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '0.000001' })).budgetDefaultMonthlyMicros).toBe(1);
    expect(() => loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '1e3' }))).toThrow();
  });
});
