import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from './db.ts';

const env = { DASHBOARD_TOKEN: 'a'.repeat(40), DASHBOARD_SESSION_SECRET: 'b'.repeat(40), DASHBOARD_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' };
const saved = { ...process.env };
beforeAll(() => Object.assign(process.env, env));
afterAll(async () => {
  await pool().end();
  delete (globalThis as { __dashboardPool?: unknown }).__dashboardPool;
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('pool', () => {
  it('is one pool with one error listener however often it is asked for, and a pool error is logged by class and code only', async () => {
    const first = pool();
    for (let i = 0; i < 25; i++) expect(pool()).toBe(first);
    expect(first.listenerCount('error')).toBe(1);
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: string) => void lines.push(l);
    try {
      first.emit('error', Object.assign(new Error('postgres://u:secret@host leaked'), { code: '57P01' }));
    } finally {
      console.error = orig;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'dashboard pool error', errClass: 'Error', code: '57P01' });
    expect(lines[0]).not.toContain('secret');
  });
});
