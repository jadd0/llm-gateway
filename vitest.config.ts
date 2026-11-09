import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.next/**'],
    include: ['packages/*/src/**/*.test.ts', 'packages/dashboard/**/*.test.{ts,tsx}', 'bench/**/*.test.ts'],
  },
});
