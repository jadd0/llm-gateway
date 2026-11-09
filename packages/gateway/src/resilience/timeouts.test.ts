import { describe, expect, it } from 'vitest';
import { codeOf, isTimeout, phaseOf } from './timeouts.ts';

const coded = (code: string, name = 'Error') => Object.assign(new Error('x'), { code, name });

describe('phaseOf', () => {
  it('undici errors map to connect headers body deadline', () => {
    expect(phaseOf(coded('UND_ERR_CONNECT_TIMEOUT'))).toBe('connect');
    expect(phaseOf(coded('ECONNREFUSED'))).toBe('connect');
    expect(phaseOf(coded('ECONNRESET'))).toBe('connect');
    expect(phaseOf(coded('UND_ERR_SOCKET'))).toBe('connect');
    expect(phaseOf(coded('UND_ERR_HEADERS_TIMEOUT'))).toBe('headers');
    expect(phaseOf(coded('UND_ERR_BODY_TIMEOUT'))).toBe('body');
    expect(phaseOf(coded('UND_ERR_ABORTED'))).toBe('deadline');
    expect(phaseOf(coded('ABORT_ERR', 'AbortError'))).toBe('deadline');
    expect(phaseOf(Object.assign(new Error('fetch failed'), { cause: coded('ECONNREFUSED') }))).toBe('connect');
    expect(phaseOf(new TypeError('boom'))).toBe('other');
    expect(phaseOf(undefined)).toBe('other');
  });
});

describe('isTimeout', () => {
  it('is true for the three timeouts, wrapped or not, and for nothing else', () => {
    expect(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].map((c) => isTimeout(coded(c)))).toEqual([true, true, true]);
    expect(isTimeout(Object.assign(new Error('fetch failed'), { cause: coded('UND_ERR_CONNECT_TIMEOUT') }))).toBe(true);
    expect(['ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED'].map((c) => isTimeout(coded(c)))).toEqual([false, false, false]);
    expect(isTimeout(new TypeError('boom'))).toBe(false);
  });
});

describe('codeOf', () => {
  it('finds the wanted code on the error or any cause, and nothing on a cycle or a stranger', () => {
    const deep = Object.assign(new Error('a'), { cause: Object.assign(new Error('b'), { code: 'FOO', cause: coded('UND_ERR_HEADERS_TIMEOUT') }) });
    expect(codeOf(deep)).toBe('UND_ERR_HEADERS_TIMEOUT');
    expect(phaseOf(deep)).toBe('headers');
    expect(isTimeout(deep)).toBe(true);
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(codeOf(loop)).toBe('');
    expect(codeOf(new TypeError('boom'))).toBe('');
    expect(codeOf(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('ABORT_ERR');
  });
});
