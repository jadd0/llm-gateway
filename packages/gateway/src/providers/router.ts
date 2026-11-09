import { PROVIDER_IDS, type ProviderId } from './types.ts';

export type ModelRoutes = Array<[prefix: string, provider: ProviderId]>;

/** "claude-=anthropic,gpt-=openai" to routes, longest prefix first. Returns a message for a bad entry. */
export function parseModelRoutes(raw: string): ModelRoutes | string {
  const routes: ModelRoutes = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const prefix = eq < 0 ? '' : entry.slice(0, eq).trim();
    const provider = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (prefix === '') return `route "${entry}" needs a model prefix before "="`;
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
      return `route "${entry}" names unknown provider "${provider}" (one of ${PROVIDER_IDS.join(', ')})`;
    }
    routes.push([prefix, provider as ProviderId]);
  }
  if (routes.length === 0) return 'MODEL_ROUTES needs at least one route';
  return routes.sort((a, b) => b[0].length - a[0].length);
}

/** The provider for a model name: the longest matching prefix, or undefined. */
export function routeModel(routes: ModelRoutes, model: string): ProviderId | undefined {
  return routes.find(([prefix]) => model.startsWith(prefix))?.[1];
}

export const DEFAULT_MODEL_ROUTES =
  'claude-=anthropic,gpt-=openai,o1=openai,o3=openai,o4=openai,gemini-=gemini,mock-anthropic-=mock-anthropic,mock-gemini-=mock-gemini,mock-openai-=mock-openai,mock-=mock-openai';
