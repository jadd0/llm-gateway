import { describe, expect, it } from 'vitest';
import { phaseOf } from './timeouts.ts';

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
