/** Ordered lists of models: the first is the one asked for, the rest stand in for it in order. */
export type Chains = string[][];

/** "a>b>c;x>y" to chains. Returns a message for a malformed value. */
export function parseFallbacks(raw: string): Chains | string {
  const chains: Chains = [];
  for (const entry of raw.split(';').map((e) => e.trim()).filter(Boolean)) {
    const models = entry.split('>').map((m) => m.trim());
    if (models.length < 2) return `chain "${entry}" needs at least two models joined by ">"`;
    if (models.some((m) => m === '')) return `chain "${entry}" has an empty model name`;
    if (new Set(models).size !== models.length) return `chain "${entry}" names a model twice`;
    chains.push(models);
  }
  const heads = chains.map((c) => c[0]!);
  const dup = heads.find((h, i) => heads.indexOf(h) !== i);
  if (dup !== undefined) return `model "${dup}" starts two chains`;
  return chains;
}

/** The models to try for a requested model, in order. A model with no chain is a chain of one. */
export function chainFor(chains: Chains, model: string): string[] {
  return chains.find((c) => c[0] === model) ?? [model];
}

/**
 * Start-up checks on a parsed value: every model in a chain must be one the gateway serves, and with
 * budgets on, one it has a price for (the hold is priced at the dearest model in the chain). Returns the
 * first problem, or undefined.
 */
export function checkChains(
  chains: Chains,
  check: { routable(model: string): boolean; priced(model: string): boolean; budgets: boolean },
): string | undefined {
  for (const chain of chains) {
    for (const model of chain) {
      if (!check.routable(model)) return `MODEL_FALLBACKS names "${model}", which no MODEL_ROUTES entry serves`;
      if (check.budgets && !check.priced(model)) {
        return `MODEL_FALLBACKS names "${model}", which has no price: with budgets on every chain model must be priced (model_not_priced)`;
      }
    }
  }
  return undefined;
}
