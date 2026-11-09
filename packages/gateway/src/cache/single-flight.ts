import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { waitReady } from '../redis.ts';
import { within } from './store.ts';
import type { Lookup } from './store.ts';

type Outcome = 'filled' | 'failed' | 'timeout';

/** What a follower's `read` reports: the entry, a plain miss, or a Redis that could not answer. */
export type Look<T> = { status: 'hit'; entry: T } | { status: 'miss' } | { status: 'unavailable' };

/** What `acquire` decided for one request that missed. */
export type Acquired =
  /** This request goes upstream for everyone. `finish` must be called when its fill is written or abandoned. */
  | { role: 'leader'; finish(outcome: 'filled' | 'failed'): void }
  /** An identical request is already going upstream. `wait` resolves with the entry, or undefined when this request should go upstream itself. */
  | { role: 'follower'; wait<T>(read: () => Promise<Look<T>>): Promise<T | undefined> }
  /** Redis could not say who leads: go upstream alone. */
  | { role: 'solo' };

export interface SingleFlight {
  acquire(key: string): Promise<Acquired>;
  /** Resolves when every lock release and notification started by a `finish` has been tried. */
  idle(): Promise<void>;
  /** Stops lock renewal (a leader that is still running loses its lock), then closes the subscriber. */
  close(): Promise<void>;
}

export interface SingleFlightOptions {
  redis: Redis;
  /** How long the leader's Redis lock lasts between renewals. A leader that stops renewing is gone after this. */
  lockMs: number;
  /** The most anyone waits for one fill, and the most a leader keeps renewing its lock. */
  waitMs: number;
  /** How often a waiting follower looks at the entry and the lock. */
  pollMs: number;
  /** A Redis answer slower than this is a failure. */
  timeoutMs: number;
  log?: { warn(obj: object, msg: string): void };
}

// Deletes the lock only if it is still this leader's: a lock that lapsed and was taken by another leader stays.
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
// Extends the lock only if it is still this leader's.
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

interface Flight {
  /** 'claiming' until the lock is decided; 'leader' when this process leads; 'remote' when another does. */
  kind: 'claiming' | 'leader' | 'remote';
  /** Resolves once the kind is decided (and, for 'remote', the notification channel is subscribed). */
  ready: Promise<void>;
  settled: Promise<Outcome>;
  done: boolean;
  polling: boolean;
  settle(outcome: Outcome): void;
  /** Called once the kind is decided and, for 'remote', the channel is subscribed. */
  decided(): void;
}

/**
 * One request in a burst of identical misses goes upstream; the others wait for its fill. Within a process
 * the first request claims the key in a map (no Redis call for the rest). Across processes the first to take
 * `SET lock NX PX` leads: it renews the lock while its call is in flight, so the lock is short and a dead
 * leader frees it within `lockMs`. Followers learn of the fill from the leader's notification, and also look
 * for it themselves every `pollMs`: entry present is a hit; no lock and no entry, or a Redis that does not
 * answer, sends them upstream at once. A failure is never shared.
 */
export function createSingleFlight(opts: SingleFlightOptions): SingleFlight {
  const flights = new Map<string, Flight>();
  const channels = new Map<string, Flight>();
  const pending = new Set<Promise<unknown>>();
  const leaving = new Set<() => void>();
  let sub: Redis | undefined;
  let subReady: Promise<boolean> | undefined;

  const dropSubscriber = () => {
    sub?.disconnect();
    sub = undefined;
    subReady = undefined;
  };

  // The subscriber is a second connection, made when the first request has to wait on another process. One
  // that never became ready is thrown away so a later call starts over.
  const subscriber = async (): Promise<Redis | undefined> => {
    if (!subReady) {
      const s = opts.redis.duplicate();
      s.on('error', () => {});
      s.on('message', (channel: string, message: string) => {
        channels.get(channel)?.settle(message === 'filled' ? 'filled' : 'failed');
      });
      sub = s;
      subReady = waitReady(s, 2000);
    }
    const attempt = subReady;
    const ok = await attempt;
    if (!ok) {
      if (subReady === attempt) dropSubscriber();
      return undefined;
    }
    return sub?.status === 'ready' ? sub : undefined;
  };

  function newFlight(): Flight {
    let settle!: (o: Outcome) => void;
    let decided!: () => void;
    const settled = new Promise<Outcome>((r) => (settle = r));
    const ready = new Promise<void>((r) => (decided = r));
    const flight: Flight = {
      kind: 'claiming',
      ready,
      settled,
      done: false,
      polling: false,
      settle: (o) => {
        flight.done = true;
        settle(o);
      },
      decided,
    };
    return flight;
  }

  // One poller per flight per process, however many requests wait on it.
  function poll<T>(key: string, flight: Flight, read: () => Promise<Look<T>>) {
    if (flight.polling || flight.done) return;
    flight.polling = true;
    const lockKey = `${key}:lock`;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      try {
        // Lock first, then the entry: a leader writes the entry before it releases the lock.
        const locked = flight.kind === 'remote' ? (await within(opts.redis.exists(lockKey), opts.timeoutMs)) === 1 : true;
        const look = await read();
        if (look.status === 'hit') flight.settle('filled');
        else if (look.status === 'unavailable' || !locked) flight.settle('failed');
      } catch {
        flight.settle('failed');
      }
      if (!flight.done) {
        timer = setTimeout(tick, opts.pollMs);
        timer.unref();
      }
    };
    timer = setTimeout(tick, opts.pollMs);
    timer.unref();
    void flight.settled.then(() => clearTimeout(timer));
  }

  const wait = (key: string, flight: Flight) =>
    async function <T>(read: () => Promise<Look<T>>): Promise<T | undefined> {
      await flight.ready;
      if (flight.kind === 'remote') {
        // The fill may have landed before this process was listening.
        const early = await read();
        if (early.status === 'hit') return early.entry;
        if (early.status === 'unavailable') return undefined;
      }
      poll(key, flight, read);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        flight.settled,
        new Promise<Outcome>((r) => {
          timer = setTimeout(() => r('timeout'), opts.waitMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === 'failed') return undefined; // the leader gave up or Redis stopped answering: go upstream
      const last = await read(); // filled, or the wait ran out: one last look
      return last.status === 'hit' ? last.entry : undefined;
    };

  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const warn = (err: unknown, msg: string) =>
    opts.log?.warn({ errClass: (err as Error).name, code: (err as { code?: string }).code }, msg);

  return {
    async acquire(key) {
      const existing = flights.get(key);
      if (existing) return { role: 'follower', wait: wait(key, existing) };

      const flight = newFlight();
      flights.set(key, flight);
      const lockKey = `${key}:lock`;
      const channel = `${key}:done`;
      const token = randomUUID();
      let won: boolean;
      try {
        won = (await within(opts.redis.set(lockKey, token, 'PX', opts.lockMs, 'NX'), opts.timeoutMs)) === 'OK';
      } catch (err) {
        // The lock may have landed even though its reply did not: take it back by token, or it lapses on its
        // own within `lockMs`. Requests that joined meanwhile go upstream too.
        track(within(opts.redis.eval(UNLOCK, 1, lockKey, token), opts.timeoutMs).catch(() => {}));
        warn(err, 'cache lock acquire failed');
        flights.delete(key);
        flight.settle('failed');
        flight.decided();
        return { role: 'solo' };
      }

      const drop = () => {
        if (flights.get(key) === flight) flights.delete(key);
        if (channels.get(channel) === flight) {
          channels.delete(channel);
          void sub?.unsubscribe(channel).catch(() => {});
        }
      };

      if (won) {
        flight.kind = 'leader';
        flight.decided();
        let finished = false;
        let renewing: NodeJS.Timeout | undefined;
        let safety: NodeJS.Timeout | undefined;
        const stop = () => {
          clearInterval(renewing);
          clearTimeout(safety);
          leaving.delete(stop);
        };
        leaving.add(stop);
        // The lock is short; renewing it while the call is in flight is what keeps the followers waiting.
        renewing = setInterval(() => {
          track(
            within(opts.redis.eval(RENEW, 1, lockKey, token, opts.lockMs), opts.timeoutMs).then(
              (kept) => {
                if (kept === 0) clearInterval(renewing); // the lock is someone else's now
              },
              (err) => warn(err, 'cache lock renewal failed'),
            ),
          );
        }, Math.max(1, Math.floor(opts.lockMs / 3)));
        renewing.unref();
        // A leader that never reports (a bug, a lost reply) is dropped when the longest wait would be over.
        safety = setTimeout(() => finish('failed'), opts.waitMs);
        safety.unref();
        const finish = (outcome: 'filled' | 'failed') => {
          if (finished) return;
          finished = true;
          stop();
          drop();
          flight.settle(outcome);
          // Lock first, then the notification, so a waiter that wakes can lead the next burst at once.
          track(
            (async () => {
              try {
                await within(opts.redis.eval(UNLOCK, 1, lockKey, token), opts.timeoutMs);
                await within(opts.redis.publish(channel, outcome), opts.timeoutMs);
              } catch (err) {
                // Followers in other processes see the lock lapse, or the entry, on their next look.
                warn(err, 'cache lock release failed');
              }
            })(),
          );
        };
        return { role: 'leader', finish };
      }

      // Another process leads: listen for it before anyone reads.
      flight.kind = 'remote';
      channels.set(channel, flight);
      void (async () => {
        try {
          const s = await subscriber();
          if (!s) throw new Error('subscriber not ready');
          await within(s.subscribe(channel), opts.timeoutMs);
        } catch {
          flight.settle('failed');
        }
        flight.decided();
      })();
      const giveUp = setTimeout(() => flight.settle('timeout'), opts.waitMs);
      giveUp.unref();
      void flight.settled.then(() => {
        clearTimeout(giveUp);
        drop();
      });
      return { role: 'follower', wait: wait(key, flight) };
    },

    async idle() {
      await Promise.allSettled([...pending]);
    },

    async close() {
      for (const stop of [...leaving]) stop();
      await Promise.allSettled([...pending]);
      sub?.disconnect();
    },
  };
}
