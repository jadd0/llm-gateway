import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { waitReady } from '../redis.ts';
import { within } from './store.ts';

type Outcome = 'filled' | 'failed' | 'timeout';

/** What `acquire` decided for one request that missed. */
export type Acquired =
  /** This request goes upstream for everyone. `finish` must be called when its fill is written or abandoned. */
  | { role: 'leader'; finish(outcome: 'filled' | 'failed'): void }
  /** An identical request is already going upstream. `wait` resolves with what `read` finds after its fill. */
  | { role: 'follower'; wait<T>(read: () => Promise<T | undefined>): Promise<T | undefined> }
  /** Redis could not say who leads: go upstream alone. */
  | { role: 'solo' };

export interface SingleFlight {
  acquire(key: string): Promise<Acquired>;
  /** Resolves when every lock release and notification started by a `finish` has been tried. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface SingleFlightOptions {
  redis: Redis;
  /** How long the leader's Redis lock lasts, and the most a leader is waited for in its own process. */
  lockMs: number;
  /** The most a follower waits for the fill before it goes upstream. */
  waitMs: number;
  /** A Redis answer slower than this is a failure. */
  timeoutMs: number;
  log?: { warn(obj: object, msg: string): void };
}

// Deletes the lock only if it is still this leader's: a lock that lapsed and was taken by another leader stays.
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

interface Flight {
  /** 'claiming' until the lock is decided; 'leader' when this process leads; 'remote' when another does. */
  kind: 'claiming' | 'leader' | 'remote';
  /** Resolves once the kind is decided (and, for 'remote', the notification channel is subscribed). */
  ready: Promise<void>;
  settled: Promise<Outcome>;
  settle(outcome: Outcome): void;
  /** Called once the kind is decided and, for 'remote', the channel is subscribed. */
  decided(): void;
}

/**
 * One request in a burst of identical misses goes upstream; the others wait for its fill. Within a process
 * the first request claims the key in a map (no Redis call for the rest). Across processes the first to take
 * `SET lock NX PX` leads and the others subscribe to its notification channel, read once after subscribing
 * (the fill may have landed before they were listening), and once more when the wait runs out. A leader
 * that fails, or never reports, makes waiters go upstream on their own: a failure is never shared.
 */
export function createSingleFlight(opts: SingleFlightOptions): SingleFlight {
  const flights = new Map<string, Flight>();
  const channels = new Map<string, Flight>();
  const pending = new Set<Promise<unknown>>();
  let sub: Redis | undefined;
  let subReady: Promise<boolean> | undefined;

  // The subscriber is a second connection, made when the first request has to wait on another process.
  const subscriber = (): Promise<Redis | undefined> => {
    if (!subReady) {
      const s = opts.redis.duplicate();
      s.on('error', () => {});
      s.on('message', (channel: string, message: string) => {
        channels.get(channel)?.settle(message === 'filled' ? 'filled' : 'failed');
      });
      sub = s;
      subReady = waitReady(s, 2000);
    }
    return subReady.then((ok) => (ok ? sub : undefined));
  };

  function newFlight(): Flight {
    let settle!: (o: Outcome) => void;
    let decided!: () => void;
    const settled = new Promise<Outcome>((r) => (settle = r));
    const ready = new Promise<void>((r) => (decided = r));
    return { kind: 'claiming', ready, settled, settle, decided };
  }

  const wait = (flight: Flight) =>
    async function <T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
      await flight.ready;
      if (flight.kind === 'remote') {
        const early = await read();
        if (early !== undefined) return early;
      }
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        flight.settled,
        new Promise<Outcome>((r) => {
          timer = setTimeout(() => r('timeout'), opts.waitMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === 'failed') return undefined; // the leader gave up; this request goes upstream itself
      return read(); // filled, or the wait ran out: one last look
    };

  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  return {
    async acquire(key) {
      const existing = flights.get(key);
      if (existing) return { role: 'follower', wait: wait(existing) };

      const flight = newFlight();
      flights.set(key, flight);
      const lockKey = `${key}:lock`;
      const channel = `${key}:done`;
      const token = randomUUID();
      let won: boolean;
      try {
        won = (await within(opts.redis.set(lockKey, token, 'PX', opts.lockMs, 'NX'), opts.timeoutMs)) === 'OK';
      } catch {
        // Nobody knows who leads. Requests that joined meanwhile go upstream too.
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
        // A leader that never reports (a bug, a lost reply) is dropped when its lock would have lapsed anyway.
        const safety = setTimeout(() => finish('failed'), opts.lockMs);
        safety.unref();
        let finished = false;
        const finish = (outcome: 'filled' | 'failed') => {
          if (finished) return;
          finished = true;
          clearTimeout(safety);
          drop();
          flight.settle(outcome);
          // Lock first, then the notification, so a waiter that wakes can lead the next burst at once.
          track(
            (async () => {
              try {
                await within(opts.redis.eval(UNLOCK, 1, lockKey, token), opts.timeoutMs);
                await within(opts.redis.publish(channel, outcome), opts.timeoutMs);
              } catch (err) {
                // Waiters in other processes fall back on their wait timeout.
                opts.log?.warn({ errClass: (err as Error).name, code: (err as { code?: string }).code }, 'cache lock release failed');
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
      return { role: 'follower', wait: wait(flight) };
    },

    async idle() {
      await Promise.allSettled([...pending]);
    },

    async close() {
      await Promise.allSettled([...pending]);
      sub?.disconnect();
    },
  };
}
