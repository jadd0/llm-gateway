import { Pool } from 'undici';
import type { Config } from './config.ts';

export interface Upstream {
  pool: Pool;
  chatPath: string;
  headers: Record<string, string>;
  close(): Promise<void>;
}

// One keep-alive pool per upstream origin. `connections` caps sockets to that origin, so the
// pool size is the number to name when it becomes the bottleneck.
export function createUpstream(config: Pick<
  Config,
  'upstreamBaseUrl' | 'upstreamApiKey' | 'upstreamConnections' | 'upstreamTimeoutMs'
>): Upstream {
  const url = new URL(config.upstreamBaseUrl);
  const pool = new Pool(url.origin, {
    connections: config.upstreamConnections,
    headersTimeout: config.upstreamTimeoutMs,
    bodyTimeout: config.upstreamTimeoutMs,
    connectTimeout: config.upstreamTimeoutMs,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
  return {
    pool,
    chatPath: '/v1/chat/completions',
    headers,
    close: () => pool.close(),
  };
}
