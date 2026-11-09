import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The repository root: the app imports the log worker's histogram code, which lives outside this package.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The same .env.local the gateway and the worker read, when there is one (variables already set win).
try {
  process.loadEnvFile(path.join(root, '.env.local'));
} catch {
  // No .env.local: the variables come from the environment.
}

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
};

export default config;
