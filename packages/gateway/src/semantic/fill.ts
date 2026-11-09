import type { SemanticSplit } from './context.ts';
import type { Embedder } from './embedder.ts';
import type { SemanticStore } from './store.ts';

/** An answer that was just cached and whose prompt should be findable by meaning. */
export interface FillJob {
  scope: string;
  split: SemanticSplit;
  /** The response-cache key holding the answer. */
  exactKey: string;
  /** How long the answer lives; the row expires with it. */
  ttlS: number;
}

export interface FillStats {
  queued: number;
  inFlight: number;
  filled: number;
  /** Jobs refused because the queue was full. */
  dropped: number;
  /** Jobs that ended without a row (no embedding, Postgres down). */
  failed: number;
}

export interface SemanticFill {
  /** Takes a job and returns at once. False when the queue is full and the job was dropped. Never throws, never waits. */
  enqueue(job: FillJob): boolean;
  stats(): FillStats;
  /** Resolves when the queue is empty and nothing is in flight. */
  idle(): Promise<void>;
  /** Stops taking jobs, drops the queue, waits for work in flight. */
  close(): Promise<void>;
}

export interface SemanticFillOptions {
  embedder: Embedder;
  store: SemanticStore;
  /** Most jobs waiting. A job arriving at a full queue is dropped. */
  queueMax: number;
  /** A last user message longer than this is not embedded. */
  maxChars: number;
  /** Embeddings in flight at once. */
  concurrency?: number;
  /** Unix ms. */
  clock?: () => number;
  log?: { warn(obj: object, msg: string): void };
}

const errInfo = (err: unknown) => ({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code });

/**
 * Embeds and stores prompts off the request path. A bounded in-memory queue: when it is full the new job is
 * dropped (that prompt just stays exact-only until it is asked again), so a burst of fills can never grow
 * memory or slow a request.
 */
export function createSemanticFill(opts: SemanticFillOptions): SemanticFill {
  const now = opts.clock ?? Date.now;
  const concurrency = opts.concurrency ?? 4;
  const queue: FillJob[] = [];
  const stats: FillStats = { queued: 0, inFlight: 0, filled: 0, dropped: 0, failed: 0 };
  let closed = false;
  let waiters: Array<() => void> = [];

  const settle = () => {
    if (queue.length === 0 && stats.inFlight === 0) {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    }
  };

  async function run(job: FillJob) {
    try {
      // Patient: this is not on anyone's request, so it may wait for a model that is still loading.
      const embedded = await opts.embedder.embed(job.split.text, { patient: true });
      if (!embedded || closed) {
        stats.failed += 1;
        return;
      }
      await opts.store.upsert({
        scope: job.scope,
        contextHash: job.split.contextHash,
        exactKey: job.exactKey,
        embedding: embedded.vector,
        embedder: embedded.embedder,
        expiresAt: new Date(now() + job.ttlS * 1000),
      });
      stats.filled += 1;
    } catch (err) {
      stats.failed += 1;
      opts.log?.warn({ ...errInfo(err), op: 'fill' }, 'semantic fill failed');
    }
  }

  function pump() {
    while (!closed && stats.inFlight < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      stats.inFlight += 1;
      void run(job).finally(() => {
        stats.inFlight -= 1;
        pump();
        settle();
      });
    }
  }

  return {
    enqueue(job) {
      if (closed || job.split.text.length > opts.maxChars) return false;
      if (queue.length >= opts.queueMax) {
        stats.dropped += 1;
        // The first drop and then every hundredth: a burst is one line, not thousands.
        if (stats.dropped === 1 || stats.dropped % 100 === 0) opts.log?.warn({ dropped: stats.dropped, queueMax: opts.queueMax }, 'semantic fill queue full, fill dropped');
        return false;
      }
      queue.push(job);
      pump();
      return true;
    },
    stats: () => ({ ...stats, queued: queue.length }),
    idle: () => (queue.length === 0 && stats.inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
    async close() {
      closed = true;
      queue.length = 0;
      await this.idle();
    },
  };
}
