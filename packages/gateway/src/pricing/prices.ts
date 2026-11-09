// What a model costs, in integer micro-USD (1 USD = 1,000,000 micro-USD). Money is never a float.

export interface Price {
  /** Micro-USD per 1,000,000 prompt tokens. */
  inPerMillion: number;
  /** Micro-USD per 1,000,000 completion tokens. */
  outPerMillion: number;
}

// Static table. Only the mock provider's models are priced for now: the mock-* price is fictitious
// ($1 in, $3 out per million tokens) and exists so budgets can be exercised and benchmarked without a
// real provider. Real models are added with their adapters, from the providers' published pricing.
const EXACT: Record<string, Price> = {};
const PREFIX: Array<[prefix: string, price: Price]> = [
  ['mock-', { inPerMillion: 1_000_000, outPerMillion: 3_000_000 }],
];

/** The price of a model, or undefined when the gateway has none (a budget cannot be enforced then). */
export function priceFor(model: string): Price | undefined {
  const exact = Object.hasOwn(EXACT, model) ? EXACT[model] : undefined;
  if (exact) return exact;
  return PREFIX.find(([p]) => model.startsWith(p))?.[1];
}

const perMillion = (tokens: number, price: number): number => Math.ceil((tokens * price) / 1_000_000);

/**
 * Cost of a call in micro-USD: each side rounded up to the next micro-USD, so rounding never favours
 * the tenant. Token counts are whole numbers; the products stay far below 2^53.
 */
export function costMicros(price: Price, promptTokens: number, completionTokens: number): number {
  return perMillion(promptTokens, price.inPerMillion) + perMillion(completionTokens, price.outPerMillion);
}

/** "1.234500": micro-USD as a USD string, by integer arithmetic. */
export function formatUsd(micros: number): string {
  const m = Math.max(0, Math.trunc(micros));
  return `${Math.floor(m / 1_000_000)}.${String(m % 1_000_000).padStart(6, '0')}`;
}

/** "12", "0.01", "3.141592" to micro-USD; undefined for anything that is not a plain USD amount. */
export function parseUsd(raw: string): number | undefined {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(raw);
  if (!m) return undefined;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
}
