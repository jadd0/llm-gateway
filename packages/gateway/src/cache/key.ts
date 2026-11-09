import { createHash } from 'node:crypto';

/** Changes whenever `normalise` does, so entries made under old rules are never read under new ones. */
export const KEY_VERSION = 'v1';

// Fields that do not change the answer. Everything else in the request is part of the key, so a field this
// file has never heard of can make two requests different but never make different requests the same.
const EXCLUDED = new Set(['stream', 'stream_options', 'user', 'metadata', 'service_tier', 'store']);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** JSON with every object's keys sorted, so field order never changes the key. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// A string and a single text part are the same prompt. Other parts (images, several text parts) are kept as sent.
function normaliseContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).length !== 2) return content;
    texts.push(part.text);
  }
  return texts.length === 1 ? texts[0] : content;
}

function normaliseMessage(message: unknown): unknown {
  if (!isRecord(message)) return message;
  return 'content' in message ? { ...message, content: normaliseContent(message.content) } : message;
}

/**
 * The request reduced to what decides the answer. Absent and null are the same; a string `stop` is a
 * one-element list; the output limit is whichever of max_completion_tokens / max_tokens is set, else the
 * gateway default (which is what the provider is asked for); a zero penalty and `n: 1` are the defaults.
 */
export function normalise(body: Record<string, unknown>, defaultMaxTokens: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (EXCLUDED.has(name) || value === null || value === undefined) continue;
    switch (name) {
      case 'max_tokens':
      case 'max_completion_tokens':
        break;
      case 'messages':
        out.messages = Array.isArray(value) ? value.map(normaliseMessage) : value;
        break;
      case 'stop':
        out.stop = typeof value === 'string' ? [value] : value;
        break;
      case 'presence_penalty':
      case 'frequency_penalty':
        if (value !== 0) out[name] = value;
        break;
      case 'n':
        if (value !== 1) out.n = value;
        break;
      default:
        out[name] = value;
    }
  }
  out.max_tokens = body.max_completion_tokens ?? body.max_tokens ?? defaultMaxTokens;
  return out;
}

/** Who may read an entry: the tenant, or the one shared pool for tenants that opted into it. */
export const scopeOf = (tenant: { tenantId: string; cacheShared: boolean }): string =>
  tenant.cacheShared ? 'shared' : tenant.tenantId;

/**
 * `{prefix}cache:v1:{scope}:{sha256}`. The scope is hashed in as well as written out: a key is only ever
 * built for the caller's own scope, there is no lookup-time filter to get wrong.
 */
export function cacheKey(prefix: string, scope: string, normalised: Record<string, unknown>): string {
  const hash = createHash('sha256').update(`${KEY_VERSION}\n${scope}\n${canonical(normalised as Json)}`).digest('hex');
  return `${prefix}cache:${KEY_VERSION}:${scope}:${hash}`;
}

export type Cacheable = { ok: true } | { ok: false; reason: string };

/**
 * Only a request whose answer should not vary, and whose answer is plain text, is cached: an explicit
 * temperature 0 (absent is the provider's default, not 0) unless the operator allows any, one choice,
 * no tools or functions, no log probabilities, no audio.
 */
export function isCacheable(body: Record<string, unknown>, config: { allowNondeterministic: boolean }): Cacheable {
  if (!config.allowNondeterministic && body.temperature !== 0) return { ok: false, reason: 'temperature is not 0' };
  if (body.n !== undefined && body.n !== null && body.n !== 1) return { ok: false, reason: 'n is not 1' };
  for (const name of ['tools', 'tool_choice', 'functions', 'function_call']) {
    if (body[name] !== undefined && body[name] !== null) return { ok: false, reason: `${name} is set` };
  }
  if (body.logprobs === true || (typeof body.top_logprobs === 'number' && body.top_logprobs > 0)) return { ok: false, reason: 'logprobs asked for' };
  if (body.audio !== undefined && body.audio !== null) return { ok: false, reason: 'audio asked for' };
  if (Array.isArray(body.modalities) && body.modalities.some((m) => m !== 'text')) return { ok: false, reason: 'modalities other than text' };
  return { ok: true };
}
