// A request's token cost before the provider has answered: the prompt at about four characters per
// token, plus the output the caller allows. The limiter charges this up front and corrects it to the
// provider's real count afterwards, so the heuristic only has to be right within one request.

const CHARS_PER_TOKEN = 4;

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

// Characters of prompt text: string contents, and the text parts of content arrays. Images and other
// non-text parts add nothing here; the correction after the call accounts for them.
function promptChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === 'string') chars += text.length;
      }
    }
  }
  return chars;
}

// The two halves of an estimate: the prompt in tokens, and the output the caller allowed (undefined when it
// named none).
export function splitRequest(body: unknown): { prompt: number; explicitOutput: number | undefined } {
  const b = (body ?? {}) as { messages?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown };
  return {
    prompt: Math.ceil(promptChars(b.messages) / CHARS_PER_TOKEN),
    explicitOutput: [b.max_tokens, b.max_completion_tokens].find(isPositiveInt),
  };
}

export interface LimitEstimate {
  /** Tokens to charge the key's token bucket. */
  cost: number;
  /** True when the request can never fit in a whole minute of the key's tokens. */
  tooLarge: boolean;
}

/**
 * The estimate as the rate limiter charges it, for a key allowed `tpm` tokens a minute. A caller who
 * names max_tokens is held to it: prompt plus max_tokens above `tpm` can never be admitted. A caller who
 * names none gets the default output allowance, trimmed to what the key could ever hold, so a small
 * request is not refused because of a guess the caller never made.
 */
export function estimateForLimit(body: unknown, defaultMaxTokens: number, tpm: number): LimitEstimate {
  const { prompt, explicitOutput: explicit } = splitRequest(body);
  if (explicit !== undefined) {
    const cost = prompt + explicit;
    return { cost, tooLarge: cost > tpm };
  }
  return { cost: prompt + Math.min(defaultMaxTokens, Math.max(0, tpm - prompt)), tooLarge: prompt > tpm };
}

export interface WorstCase {
  /** The prompt in tokens, by the same heuristic as the limiter's estimate. */
  prompt: number;
  /** The most the call can produce: the caller's max_tokens, else the default allowance. */
  output: number;
}

/**
 * The estimate as a budget reserves it. Money is held for the most the call can cost, so the output is
 * the caller's own max_tokens or the default allowance, never trimmed to a rate limit's per-minute size.
 */
export function estimateWorstCase(body: unknown, defaultMaxTokens: number): WorstCase {
  const { prompt, explicitOutput } = splitRequest(body);
  return { prompt, output: explicitOutput ?? defaultMaxTokens };
}
