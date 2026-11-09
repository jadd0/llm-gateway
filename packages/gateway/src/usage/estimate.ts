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

export function estimateTokens(body: unknown, defaultMaxTokens: number): number {
  const b = (body ?? {}) as { messages?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown };
  const output = [b.max_tokens, b.max_completion_tokens].find(isPositiveInt) ?? defaultMaxTokens;
  return Math.ceil(promptChars(b.messages) / CHARS_PER_TOKEN) + output;
}
