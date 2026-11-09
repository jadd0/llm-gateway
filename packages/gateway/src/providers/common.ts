import { randomUUID } from 'node:crypto';
import type { ChatBody } from '../request-body.ts';
import type { Usage } from '../usage/sse-usage.ts';
import type { AdapterClock, MappedError } from './types.ts';

export const defaultClock: AdapterClock = {
  now: () => Math.floor(Date.now() / 1000),
  newId: () => randomUUID(),
};

export interface Unsupported {
  param: string;
  message: string;
}

// Parameters with no equivalent in the translated formats. They are refused rather than dropped: a client
// that asks for tools or log probabilities and silently gets neither would build on a wrong answer.
const REFUSED = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'logprobs',
  'top_logprobs',
  'response_format',
  'audio',
  'modalities',
  'prediction',
  'logit_bias',
  'presence_penalty',
  'frequency_penalty',
  'seed',
] as const;

export function unsupportedParameter(body: ChatBody): Unsupported | undefined {
  for (const field of REFUSED) {
    if (body[field] !== undefined && body[field] !== null) {
      return { param: field, message: `"${field}" is not supported for this model: the gateway handles text chat only.` };
    }
  }
  if (body.n !== undefined && body.n !== 1) {
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

export const isUnsupported = (v: Conversation | Unsupported): v is Unsupported => 'param' in v;

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
