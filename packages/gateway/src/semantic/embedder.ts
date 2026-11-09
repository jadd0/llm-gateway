import { Pool } from 'undici';
import { pgErrorInfo } from '../db/pg-error.ts';

/** A vector and the model that made it. Vectors are unit length and `dimensions` long. */
export interface Embedded {
  vector: number[];
  /** `voyage-4-lite`, `voyage-4-nano`: stored with the row, and the key to same-model matching. */
  embedder: string;
}

export interface EmbedOptions {
  /** A caller that is not on the request path (the fill) may wait ten times as long. Both kinds of caller share the fallback's back-off. */
  patient?: boolean;
}

export interface Embedder {
  /** Never throws. Undefined: no vector within the time allowed. */
  embed(text: string, options?: EmbedOptions): Promise<Embedded | undefined>;
  close?(): Promise<void>;
}

type Log = { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };

/** How much longer a patient caller may wait than the request path. */
export const PATIENT_FACTOR = 10;

/** Scales a vector to length 1. Undefined when it has no length or holds a non-number. */
export function unit(v: readonly number[]): number[] | undefined {
  let sum = 0;
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
    sum += x * x;
  }
  if (sum === 0) return undefined;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}

// What the model was trained to be given in front of a query (the Voyage API adds the same for input_type).
const QUERY_PROMPT = 'Represent the query for retrieving supporting documents: ';

export interface HttpEmbedderOptions {
  dimensions: number;
  timeoutMs: number;
  /** 'query' puts the model's query prompt in front of the text; 'none' embeds the text bare. */
  inputType: 'none' | 'query';
  log?: Log;
}

// One warning when an embedder stops answering and one note when it does again, not one per request.
function outage(log: Log | undefined, embedder: string) {
  let down = false;
  return {
    failed(err: unknown) {
      if (down) return;
      down = true;
      log?.warn({ ...pgErrorInfo(err), embedder }, 'embedder unavailable, falling back or skipping the semantic step');
    },
    answered() {
      if (!down) return;
      down = false;
      log?.info({ embedder }, 'embedder available again');
    },
  };
}

class Bad extends Error {
  override name = 'EmbedBadResponse';
}

// One POST of JSON, answered within `ms` (headers and body together), returned parsed.
async function postJson(pool: Pool, path: string, headers: Record<string, string>, body: unknown, ms: number): Promise<unknown> {
  const res = await pool.request({
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw Object.assign(new Bad(`status ${res.statusCode}`), { code: `HTTP_${res.statusCode}` });
  }
  return res.body.json();
}

function vectorOf(raw: unknown, dimensions: number): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== dimensions) return undefined;
  return unit(raw as number[]);
}

export interface VoyageOptions extends HttpEmbedderOptions {
  apiKey: string;
  /** Includes the version path: https://api.voyageai.com/v1 */
  baseUrl: string;
  model: string;
}

/** Voyage's embeddings API. One keep-alive pool of its own, so a slow embedding never queues behind the providers' sockets. */
export function voyageEmbedder(opts: VoyageOptions): Embedder {
  const url = new URL(opts.baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  const pool = new Pool(url.origin, { connections: 16, connectTimeout: opts.timeoutMs });
  const status = outage(opts.log, opts.model);
  return {
    async embed(text, options) {
      const ms = options?.patient ? opts.timeoutMs * PATIENT_FACTOR : opts.timeoutMs;
      try {
        const json = (await postJson(
          pool,
          `${prefix}/embeddings`,
          { authorization: `Bearer ${opts.apiKey}` },
          {
            input: [text],
            model: opts.model,
            // Omitted (null in Voyage's terms) embeds the text as it is.
            ...(opts.inputType === 'query' ? { input_type: 'query' } : {}),
            output_dimension: opts.dimensions,
            output_dtype: 'float',
          },
          ms,
        )) as { data?: Array<{ embedding?: unknown }> };
        const vector = vectorOf(json.data?.[0]?.embedding, opts.dimensions);
        if (!vector) throw new Bad('no usable vector');
        status.answered();
        return { vector, embedder: opts.model };
      } catch (err) {
        status.failed(err);
        return undefined;
      }
    },
    close: () => pool.close(),
  };
}

export interface LocalOptions extends HttpEmbedderOptions {
  /** Ollama's origin: http://127.0.0.1:11434 */
  baseUrl: string;
  /** The pulled tag, e.g. hf.co/MongoDB/voyage-4-nano-GGUF:Q8_0 */
  model: string;
}

/** What `embedder` is recorded as for the local model: it is voyage-4-nano whichever tag serves it. */
export const LOCAL_EMBEDDER = 'voyage-4-nano';

/** Ollama's /api/embed running voyage-4-nano. Ollama cuts the 2048-dimension output to `dimensions` and re-normalises it. */
export function localEmbedder(opts: LocalOptions): Embedder {
  const url = new URL(opts.baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  const pool = new Pool(url.origin, { connections: 4, connectTimeout: opts.timeoutMs });
  const status = outage(opts.log, LOCAL_EMBEDDER);
  return {
    async embed(text, options) {
      const ms = options?.patient ? opts.timeoutMs * PATIENT_FACTOR : opts.timeoutMs;
      try {
        // The model's tokenizer expects NFC text; llama.cpp does not apply it.
        const input = (opts.inputType === 'query' ? QUERY_PROMPT : '') + text.normalize('NFC');
        const json = (await postJson(
          pool,
          `${prefix}/api/embed`,
          {},
          // The model reserves a 32k context by default (about 6 GB); a last user message is far shorter.
          { model: opts.model, input: [input], dimensions: opts.dimensions, truncate: false, options: { num_ctx: 4096, num_batch: 4096 } },
          ms,
        )) as { embeddings?: unknown[] };
        const vector = vectorOf(json.embeddings?.[0], opts.dimensions);
        if (!vector) throw new Bad('no usable vector');
        status.answered();
        return { vector, embedder: LOCAL_EMBEDDER };
      } catch (err) {
        status.failed(err);
        return undefined;
      }
    },
    close: () => pool.close(),
  };
}

export interface FallbackOptions {
  /** How long the primary is left alone after it fails, so a dead API costs one timeout, not one per request. */
  backoffMs: number;
  /** Unix ms. Tests only. */
  clock?: () => number;
}

/**
 * The primary embedder, then the local one. Each has its own time limit (set on it), so the worst case is both
 * limits added. A primary that failed (on a request or a fill) is skipped by both for `backoffMs`; with no primary every call goes local. When
 * both fail the answer is undefined and the caller skips the semantic step.
 */
export function fallbackEmbedder(primary: Embedder | undefined, local: Embedder, opts: FallbackOptions): Embedder {
  const now = opts.clock ?? Date.now;
  let skipPrimaryUntil = 0;
  return {
    async embed(text, options) {
      // A patient caller waits longer for the primary, but while the primary is known to be down it goes straight
      // to the local model like everyone else, and its own failure starts the same back-off.
      if (primary && now() >= skipPrimaryUntil) {
        const got = await primary.embed(text, options);
        if (got) return got;
        skipPrimaryUntil = now() + opts.backoffMs;
      }
      return local.embed(text, options);
    },
    async close() {
      await Promise.allSettled([primary?.close?.(), local.close?.()]);
    },
  };
}
