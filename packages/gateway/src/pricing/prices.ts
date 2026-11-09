// What a model costs, in integer micro-USD (1 USD = 1,000,000 micro-USD). Money is never a float.

export interface Price {
  /** Micro-USD per 1,000,000 prompt tokens. */
  inPerMillion: number;
  /** Micro-USD per 1,000,000 completion tokens. */
  outPerMillion: number;
  /**
   * The rates a request pays when its prompt is longer than `threshold` tokens. The provider bills the
   * whole request at them (input and output both), not only the tokens past the threshold.
   */
  longContext?: { threshold: number; inPerMillion: number; outPerMillion: number };
  /**
   * Output tokens assumed (and, where the provider needs a number, sent) when the caller names no
   * max_tokens. Absent: the gateway-wide DEFAULT_MAX_TOKENS.
   */
  defaultMaxTokens?: number;
}

/** A real model's price with where it came from, so any figure can be checked against the provider. */
export interface PriceRow extends Price {
  /** The date the provider's pricing page was read. */
  asOf: string;
  /** The pricing page. */
  source: string;
}

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const GOOGLE = 'https://ai.google.dev/gemini-api/docs/pricing'; // redirects to aistudio.google.com/docs/pricing
const AS_OF = '2026-11-09';
const usd = (v: number) => Math.round(v * 1_000_000);
const row = (
  source: string,
  inUsd: number,
  outUsd: number,
  extra: { longContext?: { threshold: number; inUsd: number; outUsd: number }; defaultMaxTokens?: number } = {},
): PriceRow => ({
  inPerMillion: usd(inUsd),
  outPerMillion: usd(outUsd),
  ...(extra.longContext
    ? { longContext: { threshold: extra.longContext.threshold, inPerMillion: usd(extra.longContext.inUsd), outPerMillion: usd(extra.longContext.outUsd) } }
    : {}),
  ...(extra.defaultMaxTokens !== undefined ? { defaultMaxTokens: extra.defaultMaxTokens } : {}),
  asOf: AS_OF,
  source,
});

// Thinking models spend output tokens on reasoning before the answer, so the gateway-wide default (1024)
// truncates them. None of the provider pages read documents a default for these models (Anthropic requires
// max_tokens; OpenAI and Google state only the model maximum), so the gateway picks this one.
const THINKING_DEFAULT_MAX_TOKENS = 4096;

// Static table, read from each provider's pricing page on the date in each row. Each provider has its
// current flagship and its smallest text model. A prompt past a model's long-context threshold is billed
// at the higher tier by the provider: Claude Haiku 5.5 over 100,000 tokens ($0.50 in / $2.50 out), Gemini
// 3.1 Pro over 200,000 ($4 / $18), GPT-6 Astra over 272,000 ($20 / $75). Models with no tier on their
// page have none here. Exact model names only: a dated snapshot of a model is not priced until it is added.
export const REAL_PRICES: Record<string, PriceRow> = {
  'claude-fable-5-1': row(ANTHROPIC, 10, 50, { defaultMaxTokens: THINKING_DEFAULT_MAX_TOKENS }),
  'claude-haiku-5-5': row(ANTHROPIC, 0.1, 0.5, {
    longContext: { threshold: 100_000, inUsd: 0.5, outUsd: 2.5 },
    defaultMaxTokens: THINKING_DEFAULT_MAX_TOKENS,
  }),
  'gpt-6-astra': row(OPENAI, 10, 50, {
    longContext: { threshold: 272_000, inUsd: 20, outUsd: 75 },
    defaultMaxTokens: THINKING_DEFAULT_MAX_TOKENS,
  }),
  'gpt-5-nano': row(OPENAI, 0.05, 0.4),
  'gemini-3.1-pro-preview': row(GOOGLE, 2, 12, {
    longContext: { threshold: 200_000, inUsd: 4, outUsd: 18 },
    defaultMaxTokens: THINKING_DEFAULT_MAX_TOKENS,
  }),
  'gemini-3.1-flash-lite': row(GOOGLE, 0.25, 1.5),
};

// The mock-* price is fictitious ($1 in, $3 out per million tokens) and exists so budgets can be exercised
// and benchmarked without a real provider.
const EXACT: Record<string, Price> = REAL_PRICES;
const PREFIX: Array<[prefix: string, price: Price]> = [
  ['mock-', { inPerMillion: 1_000_000, outPerMillion: 3_000_000 }],
];

/** The price of a model, or undefined when the gateway has none (a budget cannot be enforced then). */
export function priceFor(model: string): Price | undefined {
  const exact = Object.hasOwn(EXACT, model) ? EXACT[model] : undefined;
  if (exact) return exact;
  return PREFIX.find(([p]) => model.startsWith(p))?.[1];
}

/** The output tokens to assume for a model when the caller names none. */
export function defaultMaxTokensFor(model: string, fallback: number): number {
  return priceFor(model)?.defaultMaxTokens ?? fallback;
}

const perMillion = (tokens: number, price: number): number => Math.ceil((tokens * price) / 1_000_000);

/**
 * Cost of a call in micro-USD: each side rounded up to the next micro-USD, so rounding never favours
 * the tenant. Token counts are whole numbers; the products stay far below 2^53. A prompt longer than the
 * model's long-context threshold pays the higher rates on both sides.
 */
export function costMicros(price: Price, promptTokens: number, completionTokens: number): number {
  const rates = price.longContext && promptTokens > price.longContext.threshold ? price.longContext : price;
  return perMillion(promptTokens, rates.inPerMillion) + perMillion(completionTokens, rates.outPerMillion);
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
