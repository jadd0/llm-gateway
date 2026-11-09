import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';

describe('db:migrate', () => {
  it('runs with only DATABASE_URL set', async () => {
    const { databaseUrl } = testConfig();
    const script = fileURLToPath(new URL('./migrate.ts', import.meta.url));
    // No pepper, no Redis URL, nothing inherited from this process.
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: databaseUrl },
    });
    expect(stdout).toContain('migrations applied');
  });
});
