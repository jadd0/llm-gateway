import { Pool } from 'undici';
import type { Config } from './config.ts';
import { createAnthropicAdapter } from './providers/anthropic.ts';
import { createGeminiAdapter } from './providers/gemini.ts';
import { createOpenAiAdapter } from './providers/openai.ts';
import { routeModel } from './providers/router.ts';
import type { Adapter, ProviderId } from './providers/types.ts';

/** Where and how one provider is called. */
export interface Target {
  provider: ProviderId;
  adapter: Adapter;
  pool: Pool;
  /** The base URL's path, kept and joined in front of the adapter's request path ('' for none). */
  basePath: string;
  /** This provider's own key, if it has one. */
  apiKey: string | undefined;
  /** False when a real provider has no key: requests for it are refused, the gateway still starts. */
  configured: boolean;
}

export interface Upstream {
  /** The target for a model name, or undefined when no route matches. */
  resolve(model: string): Target | undefined;
  close(): Promise<void>;
}

const joinPath = (base: string, extra = '') => `${base.replace(/\/+$/, '')}${extra}`;

type PoolSettings = Pick<Config, 'upstreamConnections' | 'upstreamConnectTimeoutMs' | 'upstreamHeadersTimeoutMs' | 'upstreamIdleTimeoutMs'>;

type TargetConfig = Pick<
  Config,
  | 'upstreamBaseUrl'
  | 'upstreamApiKey'
  | 'anthropicBaseUrl'
  | 'anthropicApiKey'
  | 'anthropicVersion'
  | 'geminiBaseUrl'
  | 'geminiApiKey'
  | 'mockBaseUrl'
  | 'mockAnthropicBaseUrl'
  | 'mockGeminiBaseUrl'
  | 'modelRoutes'
> &
  PoolSettings;

// One keep-alive pool per upstream origin (created on first use). `connections` caps sockets to that
// origin, so the pool size is the number to name when it becomes the bottleneck. The three mock formats
// share an origin and so a pool unless MOCK_ANTHROPIC_BASE_URL or MOCK_GEMINI_BASE_URL moves one away.
// The three timeouts apply to every attempt made on the pool: connecting, waiting for response headers,
// and silence between body bytes.
export function createUpstream(config: TargetConfig): Upstream {
  const pools = new Map<string, Pool>();
  const poolFor = (origin: string) => {
    let pool = pools.get(origin);
    if (!pool) {
      pool = new Pool(origin, {
        connections: config.upstreamConnections,
        connectTimeout: config.upstreamConnectTimeoutMs,
        headersTimeout: config.upstreamHeadersTimeoutMs,
        bodyTimeout: config.upstreamIdleTimeoutMs,
      });
      pools.set(origin, pool);
    }
    return pool;
  };

  // One adapter per wire format, shared by the real provider and its mock: they speak the same format.
  const openai = createOpenAiAdapter();
  const anthropic = createAnthropicAdapter({ version: config.anthropicVersion });
  const gemini = createGeminiAdapter();

  const make = (provider: ProviderId, adapter: Adapter, baseUrl: string, apiKey: string | undefined, mock: boolean, extra = ''): Target => {
    const url = new URL(baseUrl);
    return {
      provider,
      adapter,
      pool: poolFor(url.origin),
      basePath: joinPath(url.pathname, extra),
      apiKey,
      configured: mock || apiKey !== undefined,
    };
  };
  const factories: Record<ProviderId, () => Target> = {
    openai: () => make('openai', openai, config.upstreamBaseUrl, config.upstreamApiKey, false),
    anthropic: () => make('anthropic', anthropic, config.anthropicBaseUrl, config.anthropicApiKey, false),
    gemini: () => make('gemini', gemini, config.geminiBaseUrl, config.geminiApiKey, false),
    // The mock serves each format at the path the real provider uses, under the same version prefix.
    'mock-openai': () => make('mock-openai', openai, config.mockBaseUrl, undefined, true, '/v1'),
    'mock-anthropic': () => make('mock-anthropic', anthropic, config.mockAnthropicBaseUrl, undefined, true),
    'mock-gemini': () => make('mock-gemini', gemini, config.mockGeminiBaseUrl, undefined, true, '/v1beta'),
  };
  const targets = new Map<ProviderId, Target>();

  return {
    resolve(model) {
      const provider = routeModel(config.modelRoutes, model);
      if (provider === undefined) return undefined;
      let target = targets.get(provider);
      if (!target) {
        target = factories[provider]();
        targets.set(provider, target);
      }
      return target;
    },
    close: async () => {
      await Promise.all([...pools.values()].map((p) => p.close()));
    },
  };
}
