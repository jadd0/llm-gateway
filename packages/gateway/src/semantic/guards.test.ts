import { describe, expect, it } from 'vitest';
import { failedGuard, guardSignature, type GuardOptions } from './guards.ts';

const ON: GuardOptions = { tokenSet: true, maxDiff: 2 };
const OFF: GuardOptions = { tokenSet: false, maxDiff: 2 };
// The rule that refuses a stored prompt `a` for a request `b`, or undefined when both guards pass.
const verdict = (a: string, b: string, o: GuardOptions = ON) => failedGuard(guardSignature(a), guardSignature(b), o);

describe('guard signature', () => {
  it('holds hashes, never the prompt', () => {
    const sig = guardSignature('Refund order #1234 for "Acme Corp" and never call Alice');
    const text = JSON.stringify(sig);
    for (const secret of ['1234', 'Acme', 'acme', 'Alice', 'alice', 'refund', 'call']) expect(text).not.toContain(secret);
    expect(sig).toMatchObject({ v: 1, negations: 1 });
    // Sorted, so equal content gives equal signatures whatever the order.
    expect(guardSignature('b a')).toEqual(guardSignature('a b'));
  });
});

describe('numbers and IDs', () => {
  it('differing numbers refuse, whatever the rest says', () => {
    expect(verdict('refund order number 1234', 'refund order number 1235')).toBe('numbers');
    expect(verdict('pay 3.5 dollars', 'pay 35 dollars')).toBe('numbers');
    expect(verdict('ticket A-123 status', 'ticket B-123 status')).toBe('numbers');
    // Multisets: the same digits a different number of times are different.
    expect(verdict('call 5 and 5', 'call 5')).toBe('numbers');
    expect(verdict('call 5', 'call')).toBe('numbers');
  });
  it('the same numbers in a different order or with a leading # agree', () => {
    expect(verdict('compare 3 with 10', 'compare 10 with 3')).toBeUndefined();
    expect(verdict('refund order #1234', 'refund order 1234')).toBeUndefined();
    expect(verdict('1,000 users', '1,000 users')).toBeUndefined();
  });
});

describe('quoted strings', () => {
  it('differing quotes refuse; apostrophes are not quotes', () => {
    expect(verdict(`translate 'good morning'`, `translate 'good night'`)).toBe('quotes');
    expect(verdict('say "hello world" twice', 'say "hello there" twice')).toBe('quotes');
    expect(verdict('run `rm -rf build`', 'run `rm -rf dist`')).toBe('quotes');
    expect(verdict('what does “ship” mean', 'what does “sail” mean')).toBe('quotes');
    expect(verdict(`translate 'good morning'`, 'translate good morning')).toBe('quotes');
    // Apostrophes inside words open no quote: both sides here have none.
    expect(guardSignature(`it's Bob's`).quotes).toEqual([]);
    expect(verdict(`translate 'good morning'`, `translate 'good morning'`)).toBeUndefined();
  });
});

describe('names', () => {
  it('a different proper noun refuses; a sentence-initial capital is not one', () => {
    expect(verdict('what is the capital of France', 'what is the capital of Spain')).toBe('names');
    expect(verdict('how do I reset my Slack password', 'how do I reset my Teams password')).toBe('names');
    expect(verdict('Where is the office. Ask Bob', 'where is the office. ask Bob')).toBeUndefined();
    expect(verdict('Hello there how are you', 'Hi there how are you', OFF)).toBeUndefined();
    // Sets: repeating a name changes nothing, adding one does.
    expect(verdict('is Paris near Paris', 'is Paris far')).toBeUndefined();
    expect(verdict('is Paris near', 'is Paris near Rome')).toBe('names');
    // A line break starts a sentence too: the capital after it is not a name, the one inside the line is.
    expect(guardSignature('first line\nSecond Line').names).toHaveLength(1);
    expect(guardSignature('First line.\nSecond line').names).toHaveLength(0);
    // "I" is a pronoun.
    expect(guardSignature('how can I help').names).toEqual([]);
  });
});

describe('negation', () => {
  it('a different count of negation words refuses', () => {
    expect(verdict('is it safe to eat this', 'is it not safe to eat this')).toBe('negation');
    expect(verdict('can I get a refund', "can't I get a refund")).toBe('negation');
    expect(verdict('works with the app', 'works without the app')).toBe('negation');
    expect(verdict('I can do it', 'I cannot do it')).toBe('negation');
    expect(verdict('never do this', 'do this')).toBe('negation');
  });
  it('different words with the same count agree', () => {
    expect(verdict('why does it not work', 'why does it never work')).toBeUndefined();
    expect(verdict("it doesn't work", 'it does not work')).toBeUndefined();
    expect(verdict("it doesn’t work", "it doesn't work")).toBeUndefined();
  });
});

describe('content words', () => {
  it('words differing by more than the limit refuse; fewer pass; stop words and case do not count', () => {
    expect(verdict('how do I reset my password', 'how can I change my billing address')).toBe('tokens');
    expect(verdict('how do I reset my password', 'How do I reset my password?')).toBeUndefined();
    // The sets differ by exactly the limit (one word each way): served; one more word: refused.
    expect(verdict('reset account password quickly', 'reset account password fast')).toBeUndefined();
    expect(verdict('reset account password quickly', 'reset account password fast today')).toBe('tokens');
    expect(verdict('the cat sat on the mat', 'a cat sat on a mat')).toBeUndefined();
  });
  it('the limit is configurable and the guard can be switched off', () => {
    expect(verdict('reset account password quickly', 'reset account password fast today', { tokenSet: true, maxDiff: 3 })).toBeUndefined();
    expect(verdict('reset account password quickly', 'reset account password fast today', { tokenSet: true, maxDiff: 0 })).toBe('tokens');
    expect(verdict('how do I reset my password', 'how can I change my billing address', OFF)).toBeUndefined();
  });
});

describe('order and unknown signatures', () => {
  it('the first failing rule is named, in the documented order', () => {
    expect(verdict("order 1 'a' Bob not here", 'order 2 "b" Tom here')).toBe('numbers');
    expect(verdict("order 1 'a' Bob not here", "order 1 'b' Tom here")).toBe('quotes');
    expect(verdict("order 1 'a' Bob not here", "order 1 'a' Tom here")).toBe('names');
    expect(verdict("order 1 'a' Bob not here", "order 1 'a' Bob here")).toBe('negation');
  });
  it('a stored signature this code cannot read is refused', () => {
    expect(failedGuard(undefined, guardSignature('x'), ON)).toBe('signature');
    expect(failedGuard({ ...guardSignature('x'), v: 2 } as never, guardSignature('x'), ON)).toBe('signature');
  });
  it('identical prompts always pass', () => {
    for (const p of ['refund order #1234 for "Acme" never', 'What is 2+2?', 'ünïcode Straße München 東京']) expect(verdict(p, p)).toBeUndefined();
  });
});
