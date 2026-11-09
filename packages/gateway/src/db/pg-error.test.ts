import { describe, expect, it } from 'vitest';
import { pgErrorInfo } from './pg-error.ts';

describe('pgErrorInfo', () => {
  it('reads the class and the code, from the cause when the error is a wrapper', () => {
    expect(pgErrorInfo(Object.assign(new Error('secret'), { code: 'ECONNREFUSED' }))).toEqual({ errClass: 'Error', code: 'ECONNREFUSED' });
    const wrapper = Object.assign(new Error('Failed query: select secret', { cause: Object.assign(new Error('secret'), { code: '57014' }) }), { name: 'DrizzleQueryError' });
    expect(pgErrorInfo(wrapper)).toEqual({ errClass: 'DrizzleQueryError', code: '57014' });
    expect(pgErrorInfo(new Error('no code'))).toEqual({ errClass: 'Error', code: undefined });
    expect(pgErrorInfo(undefined)).toEqual({ errClass: undefined, code: undefined });
    expect(JSON.stringify(pgErrorInfo(new Error('secret prompt text', { cause: { code: '08006' } })))).not.toContain('secret');
  });
});
