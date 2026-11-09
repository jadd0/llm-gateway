/** What is kept of a served answer: enough to rebuild a reply in either shape. */
export interface CachedCompletion {
  content: string;
  finishReason: 'stop' | 'length';
  /** What the provider reported; null when it reported none. */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  /** The model that actually served it (a fallback may differ from the one asked for). */
  model: string;
}

export interface ReplayIdentity {
  /** `chatcmpl-cache-…`: a hit is a new reply, not a copy of the first one's id. */
  id: string;
  /** Unix seconds. */
  created: number;
}

const usageJson = (u: NonNullable<CachedCompletion['usage']>) => ({
  prompt_tokens: u.promptTokens,
  completion_tokens: u.completionTokens,
  total_tokens: u.totalTokens,
});

/** The stored answer as a non-streamed `chat.completion`. */
export function replayBody(entry: CachedCompletion, who: ReplayIdentity): Record<string, unknown> {
  return {
    id: who.id,
    object: 'chat.completion',
    created: who.created,
    model: entry.model,
    choices: [{ index: 0, message: { role: 'assistant', content: entry.content }, finish_reason: entry.finishReason }],
    ...(entry.usage ? { usage: usageJson(entry.usage) } : {}),
  };
}

/** Cuts text into pieces of `size` code points, so a character (an emoji) is never split between pieces. */
export function pieces(text: string, size: number): string[] {
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''));
  return out;
}

/**
 * The stored answer as OpenAI stream events: a role chunk, the content in `chunkChars` pieces, the finish
 * chunk, a usage-only chunk when the client asked for one and there is usage, then [DONE]. The whole text is
 * returned at once; a hit has nothing to wait for.
 */
export function replayStream(
  entry: CachedCompletion,
  who: ReplayIdentity,
  options: { chunkChars: number; includeUsage: boolean },
): string {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: who.id, object: 'chat.completion.chunk', created: who.created, model: entry.model, choices, ...extra })}\n\n`;
  let out = chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  for (const piece of pieces(entry.content, options.chunkChars)) {
    out += chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]);
  }
  out += chunk([{ index: 0, delta: {}, finish_reason: entry.finishReason }]);
  if (options.includeUsage && entry.usage) out += chunk([], { usage: usageJson(entry.usage) });
  return `${out}data: [DONE]\n\n`;
}
