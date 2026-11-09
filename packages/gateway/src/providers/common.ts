import { randomUUID } from 'node:crypto';
import type { ChatBody } from '../request-body.ts';
import type { Usage } from '../usage/sse-usage.ts';
import { sseData } from './sse.ts';
import type { AdapterClock, MappedError } from './types.ts';

export const defaultClock: AdapterClock = {
  now: () => Math.floor(Date.now() / 1000),
  newId: () => randomUUID(),
};

export interface Unsupported {
  param: string;
  message: string;
}

// Parameters with no equivalent in the translated formats. A value that asks for something is refused rather
// than dropped: a client that asks for tools or log probabilities and silently gets neither would build on
// a wrong answer. A neutral value (what an SDK sends for "no preference") asks for nothing and passes.
const isNull = (v: unknown) => v === undefined || v === null;
const isZero = (v: unknown) => isNull(v) || v === 0;
const REFUSED: Record<string, (value: unknown) => boolean> = {
  tools: isNull,
  tool_choice: isNull,
  functions: isNull,
  function_call: isNull,
  parallel_tool_calls: isNull,
  logprobs: (v) => isNull(v) || v === false,
  top_logprobs: isZero,
  response_format: isNull,
  audio: isNull,
  modalities: isNull,
  prediction: isNull,
  logit_bias: isNull,
  presence_penalty: isZero,
  frequency_penalty: isZero,
  seed: isNull,
  reasoning_effort: isNull,
};
// Fields these formats have no use for, dropped without a word: they change nothing about the answer
// (user, metadata, service_tier, store).

export function unsupportedParameter(body: ChatBody): Unsupported | undefined {
  for (const [field, neutral] of Object.entries(REFUSED)) {
    if (!neutral(body[field])) {
      return { param: field, message: `"${field}" is not supported for this model: the gateway handles text chat only.` };
    }
  }
  if (!isNull(body.n) && body.n !== 1) {
    return { param: 'n', message: '"n" above 1 is not supported for this model: the gateway returns one choice.' };
  }
  return undefined;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Conversation {
  system: string[];
  /** Consecutive same-role messages merged into one turn. */
  turns: Turn[];
}

// Text content only: a string, or an array of {type:'text'} parts. Anything else (images, audio, files,
// tool calls, a tool-result message) is refused naming the field.
export function conversation(messages: unknown[]): Conversation | Unsupported {
  const system: string[] = [];
  const turns: Turn[] = [];
  for (const [i, m] of messages.entries()) {
    const msg = (m ?? {}) as { role?: unknown; content?: unknown; tool_calls?: unknown };
    const at = `messages[${i}]`;
    if (msg.tool_calls !== undefined) {
      return { param: `${at}.tool_calls`, message: `"${at}.tool_calls" is not supported for this model.` };
    }
    let text: string;
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const [j, p] of msg.content.entries()) {
        const part = (p ?? {}) as { type?: unknown; text?: unknown };
        if (part.type !== 'text' || typeof part.text !== 'string') {
          return {
            param: `${at}.content[${j}].type`,
            message: `"${at}.content[${j}]" is not supported for this model: only text content parts are.`,
          };
        }
        parts.push(part.text);
      }
      text = parts.join('');
    } else {
      return { param: `${at}.content`, message: `"${at}.content" must be a string or an array of text parts.` };
    }
    if (msg.role === 'system' || msg.role === 'developer') {
      system.push(text);
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      const last = turns.at(-1);
      if (last && last.role === msg.role) last.text += `\n\n${text}`;
      else turns.push({ role: msg.role, text });
    } else {
      return { param: `${at}.role`, message: `"${at}.role" is not supported for this model.` };
    }
  }
  return { system, turns };
}

export const isUnsupported = (v: object): v is Unsupported => 'param' in v;

export const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export interface Prepared {
  convo: Conversation;
  stop: string[] | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  /** The caller's output limit (max_tokens, else max_completion_tokens), if it gave one. */
  maxTokens: number | undefined;
}

// The part of building a request that every translated provider shares: refuse what cannot be translated,
// flatten the messages, read the sampling fields.
export function prepare(body: ChatBody): Prepared | Unsupported {
  const refused = unsupportedParameter(body);
  if (refused) return refused;
  const convo = conversation(body.messages);
  if (isUnsupported(convo)) return convo;
  const stop = body.stop === undefined || body.stop === null ? undefined : stopList(body.stop);
  if (body.stop !== undefined && body.stop !== null && stop === undefined) {
    return { param: 'stop', message: '"stop" must be a string or an array of strings.' };
  }
  return {
    convo,
    stop,
    temperature: num(body.temperature),
    topP: num(body.top_p),
    maxTokens: positiveInt(body.max_tokens) ?? positiveInt(body.max_completion_tokens),
  };
}

export function stopList(stop: unknown): string[] | undefined {
  if (typeof stop === 'string') return [stop];
  if (Array.isArray(stop) && stop.every((s) => typeof s === 'string')) return stop as string[];
  return undefined;
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function toUsage(promptTokens: number, completionTokens: number): Usage {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export const openaiUsage = (u: Usage) => ({
  prompt_tokens: u.promptTokens,
  completion_tokens: u.completionTokens,
  total_tokens: u.totalTokens,
});

export function completionObject(opts: {
  id: string;
  created: number;
  model: string;
  text: string;
  finish: string;
  usage: Usage | undefined;
}) {
  return {
    id: opts.id,
    object: 'chat.completion',
    created: opts.created,
    model: opts.model,
    choices: [{ index: 0, message: { role: 'assistant', content: opts.text }, finish_reason: opts.finish }],
    ...(opts.usage ? { usage: openaiUsage(opts.usage) } : {}),
  };
}

export function chunkObject(
  base: { id: string; created: number; model: string },
  delta: Record<string, unknown>,
  finish: string | null,
) {
  return { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] };
}

export function usageChunk(base: { id: string; created: number; model: string }, usage: Usage) {
  return { ...base, object: 'chat.completion.chunk', choices: [], usage: openaiUsage(usage) };
}

export function errorEvent(message: string, type: string, code: string) {
  return { error: { message, type, code } };
}

/** What a provider's mid-stream error means to an OpenAI client. */
export type ProviderErrorKind = 'invalid_request' | 'rate_limit' | 'auth' | 'server';

// The error event a client sees when the provider fails after the answer began (the 200 is already sent):
// the same type and code its non-streamed twin would carry. Only a request the provider rejected as invalid
// stays a client error; overload and provider faults are server errors; a rejected gateway credential is the
// gateway's problem and says so without the provider's wording.
export function providerStreamError(kind: ProviderErrorKind, message: string, providerCode: string, provider: string): string {
  switch (kind) {
    case 'invalid_request':
      return sseData(errorEvent(message, 'invalid_request_error', providerCode));
    case 'rate_limit':
      return sseData(errorEvent(message, 'rate_limit_error', 'rate_limit_exceeded'));
    case 'auth':
      return sseData(errorEvent(providerAuthMessage(provider), 'gateway_error', 'provider_auth_failed'));
    default:
      return sseData(errorEvent(message, 'server_error', providerCode));
  }
}

export const providerAuthMessage = (provider: string) => `the gateway's credentials for ${provider} were rejected`;

/** The stream ended before the provider finished the answer. */
export const incompleteStreamEvent = () =>
  sseData(errorEvent('provider stream ended before the answer was complete', 'server_error', 'upstream_stream_incomplete'));

export function openaiErrorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function mapped(status: number, message: string, code: string | undefined): MappedError {
  return {
    status,
    body: { error: { message, type: openaiErrorType(status), ...(code ? { code } : {}) } },
  };
}

export function tryJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}
