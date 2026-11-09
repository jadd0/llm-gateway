import { Redis } from 'ioredis';

interface ClientState {
  everReady: boolean;
  createdAt: number;
  startupGraceMs: number;
}
const states = new WeakMap<Redis, ClientState>();

// One client per process. Commands fail fast while Redis is unreachable (no offline queue, short
// command timeout) so callers can fall back to Postgres instead of stacking up behind a dead socket.
// Reconnection is automatic with a capped back-off, so a Redis restart needs no gateway restart.
export function createRedis(url: string, opts: { startupGraceMs?: number } = {}): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1000),
  });
  const state: ClientState = {
    everReady: false,
    createdAt: Date.now(),
    startupGraceMs: opts.startupGraceMs ?? 2000,
  };
  states.set(redis, state);
  redis.on('ready', () => {
    state.everReady = true;
  });
  // Without a listener an 'error' event would throw; outages are reported by the key store.
  redis.on('error', () => {});
  return redis;
}

// True while a new client has not yet had its first connection and is still inside its startup
// grace: a command failing now means "still connecting", not "Redis is down".
export function isStarting(redis: Redis): boolean {
  const s = states.get(redis);
  return s !== undefined && !s.everReady && Date.now() - s.createdAt < s.startupGraceMs;
}

// Resolves true once the client is ready; false if it is not ready within timeoutMs or the connection
// attempt fails first (close/end). Commands sent before 'ready' fail (no offline queue), so a
// short-lived caller such as the CLI waits first.
export function waitReady(redis: Redis, timeoutMs: number): Promise<boolean> {
  if (redis.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('close', onClosed);
      redis.off('end', onClosed);
      resolve(ok);
    };
    const onReady = () => done(true);
    const onClosed = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    redis.on('ready', onReady);
    redis.on('close', onClosed);
    redis.on('end', onClosed);
  });
}
