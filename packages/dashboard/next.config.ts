import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The repository root: the app imports the log worker's histogram code, which lives outside this package.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
};

export default config;
