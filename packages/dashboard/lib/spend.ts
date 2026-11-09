import { toUsd } from './format.ts';
import type { TenantSpend } from './queries.ts';

export interface SpendBar {
  name: string;
  usd: number;
}

/** The biggest spenders by name, and the rest together, so the chart stays readable with many tenants. */
export function spendBars(byTenant: TenantSpend[], top = 10): SpendBar[] {
  const shown = byTenant.slice(0, top).map((t) => ({ name: t.name, usd: toUsd(t.costMicros) }));
  const rest = byTenant.slice(top);
  return rest.length > 0 ? [...shown, { name: `Other (${rest.length})`, usd: toUsd(rest.reduce((s, t) => s + t.costMicros, 0)) }] : shown;
}
