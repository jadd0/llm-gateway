import { createHash } from 'node:crypto';
import { canonical, KEY_VERSION } from '../cache/key.ts';

/** A request split into the one thing that may differ between a request and the entry that serves it, and everything that may not. */
export interface SemanticSplit {
  /** The last user message, as text. This is what gets embedded. */
  text: string;
  /** sha256 of the normalised request without that message's text: model, parameters, system prompt and earlier turns all feed it. */
  contextHash: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Splits a request already reduced by `normalise` (cache/key.ts) into its last user message and a hash of the
 * rest. Only the text of that message is left out of the hash: its role and any other field it carries (a
 * `name`) stay in, so two requests share a context only when they are the same request with different words
 * in the final user turn.
 *
 * Undefined when the request has no such message to compare: the last message is not a user message, or its
 * content is not plain text (an image, several parts), or the text is empty. Those requests only ever use the
 * exact cache.
 */
export function splitForSemantic(normalised: Record<string, unknown>): SemanticSplit | undefined {
  const messages = normalised.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last: unknown = messages[messages.length - 1];
  if (!isRecord(last) || last.role !== 'user' || typeof last.content !== 'string' || last.content.trim() === '') return undefined;
  const { content: text, ...lastRest } = last;
  const context = { ...normalised, messages: [...messages.slice(0, -1), lastRest] };
  const contextHash = createHash('sha256')
    .update(`${KEY_VERSION}\n${canonical(context as Parameters<typeof canonical>[0])}`)
    .digest('hex');
  return { text, contextHash };
}
