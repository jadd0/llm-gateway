import { Redis } from 'ioredis';

// One client per process. Commands fail fast while Redis is unreachable (no offline queue, short
// command timeout) so callers can fall back to Postgres instead of stacking up behind a dead socket.
// Reconnection is automatic with a capped back-off, so a Redis restart needs no gateway restart.
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1000),
  });
  // Without a listener an 'error' event would throw; outages are reported by the key store.
  redis.on('error', () => {});
  return redis;
}
