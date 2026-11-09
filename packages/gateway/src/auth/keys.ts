import { createHmac, randomBytes } from 'node:crypto';

export const KEY_PREFIX_LENGTH = 12;

// `gw_` plus 32 random bytes as base64url (43 characters).
const KEY_SHAPE = /^gw_[A-Za-z0-9_-]{43}$/;

export const generateKey = (): string => `gw_${randomBytes(32).toString('base64url')}`;

// What is shown and stored next to the hash so a key can be recognised and revoked without the key.
export const keyPrefix = (key: string): string => key.slice(0, KEY_PREFIX_LENGTH);

// Keys are 256 random bits, so a fast keyed hash is enough; the pepper means a stolen database
// alone cannot be used to test guesses.
export const hashKey = (pepper: string, key: string): string =>
  createHmac('sha256', pepper).update(key).digest('hex');

export const looksLikeKey = (candidate: string): boolean => KEY_SHAPE.test(candidate);

// Extracts the token from `Authorization: Bearer <token>`; undefined for anything else.
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header);
  return match?.[1];
}
