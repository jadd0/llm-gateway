import type { Redis } from 'ioredis';
import { streamKey, toLogFields, type LogEntry } from './entry.ts';

/** Where finished request-log entries go. `write` never throws; the stream sink returns at once, the inline one when the row is in. */
export interface Sink {
  write(entry: LogEntry): void | Promise<void>;
  /** Entries given up on because the buffer was full while Redis was away. */
  dropped(): number;
  /** Entries waiting in memory for Redis to come back. */
  buffered(): number;
  /** Sends what it can, waits for writes in flight, then gives up on the rest (counted). */
  close(): Promise<void>;
}

export interface StreamSinkOptions {
  redis: Pick<Redis, 'xadd'>;
  keyPrefix: string;
  /** Approximate length cap of the request-log stream (XADD MAXLEN ~): the oldest entries go first. Unset: no cap. */
  streamMax?: number;
  /** Entries held in memory while Redis is down; more are dropped and counted. */
  bufferMax: number;
  /** How often a non-empty buffer is retried. */
  flushMs?: number;
  /** How long `close` keeps retrying a buffer before dropping it. */
  closeWaitMs?: number;
  log?: { warn(obj: object, msg: string): void };
}

const errInfo = (err: unknown) => ({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code });

/**
 * One XADD per entry, off the request path. While Redis cannot take them, entries wait in a bounded in-memory
 * buffer, in order, and are sent when it can; past the bound they are dropped and counted (logged at most once a
 * minute). Only request-log entries are ever buffered here: settled spend goes through the budget, which writes it
 * to Postgres itself when Redis is away.
 */
export function createStreamSink(o: StreamSinkOptions): Sink {
  const key = streamKey(o.keyPrefix);
  // `~` lets Redis trim in whole blocks, which costs nothing per call. Only this stream is capped; spend has its own.
  const cap: Array<string | number> = o.streamMax === undefined ? [] : ['MAXLEN', '~', o.streamMax];
  const xadd = (fields: string[]) => (o.redis.xadd as (...a: Array<string | number>) => Promise<unknown>)(key, ...cap, '*', ...fields);
  const buffer: string[][] = [];
  const inFlight = new Set<Promise<void>>();
  let dropped = 0;
  let droppedLogged = 0;
  let lastDropLog = 0;
  let flushing: Promise<void> | null = null;

  const noteDrop = () => {
    dropped++;
    const now = Date.now();
    if (now - lastDropLog >= 60_000) {
      lastDropLog = now;
      o.log?.warn({ dropped, since: dropped - droppedLogged }, 'request log entries dropped: Redis is unavailable and the buffer is full');
      droppedLogged = dropped;
    }
  };

  // Sends the buffer front to back; stops at the first failure so order is kept.
  const flush = (): Promise<void> => {
    flushing ??= (async () => {
      try {
        while (buffer.length > 0) {
          await xadd(buffer[0]!);
          buffer.shift();
        }
      } catch {
        // Redis is still away: try again on the next tick.
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };
  const timer = setInterval(() => {
    if (buffer.length > 0) void flush();
  }, o.flushMs ?? 250);
  timer.unref();

  const hold = (fields: string[]) => {
    if (buffer.length >= o.bufferMax) noteDrop();
    else buffer.push(fields);
  };

  return {
    write(entry) {
      const fields = toLogFields(entry);
      // Behind an older buffered entry: keep the order.
      if (buffer.length > 0) return hold(fields);
      const p: Promise<void> = Promise.resolve()
        .then(() => xadd(fields))
        .then(
          () => undefined,
          (err: unknown) => {
            o.log?.warn(errInfo(err), 'request log entry could not be queued, buffered');
            hold(fields);
          },
        )
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    dropped: () => dropped,
    buffered: () => buffer.length,
    async close() {
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
      const until = Date.now() + (o.closeWaitMs ?? 2000);
      while (buffer.length > 0 && Date.now() < until) {
        await flush();
        if (buffer.length > 0) await new Promise((r) => setTimeout(r, 50));
      }
      while (buffer.length > 0) {
        buffer.shift();
        noteDrop();
      }
    },
  };
}

/** Discards everything: for an app with no Redis and no inline logging. */
export const nullSink: Sink = { write() {}, dropped: () => 0, buffered: () => 0, close: async () => {} };
