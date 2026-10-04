// credentials.ts - hashPassword/verifyPassword round-trip contract.
//
// Regression test for the bug where verifyPassword hex-decoded the stored
// salt into raw bytes before calling scryptSync, while hashPassword (and
// better-auth's own @better-auth/utils implementation) use the salt's hex
// STRING verbatim as the scrypt salt input. That mismatch meant a correctly
// hashed password could never verify - "Current password is incorrect" on
// every attempt, even with the right password.
import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './credentials';

describe('credentials (hashPassword / verifyPassword)', () => {
  it('verifies a password against its own hash', () => {
    const stored = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
  });

  it('rejects an incorrect password against a real hash', () => {
    const stored = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('stores the salt as the raw hex string (not re-encoded)', () => {
    const stored = hashPassword('another-password-123');
    const [salt] = stored.split(':');
    // randomBytes(16).toString('hex') is always 32 hex chars.
    expect(salt).toHaveLength(32);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects malformed stored values instead of throwing', () => {
    expect(verifyPassword('anything', null)).toBe(false);
    expect(verifyPassword('anything', undefined)).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'no-colon-here')).toBe(false);
    expect(verifyPassword('anything', ':missing-salt')).toBe(false);
    expect(verifyPassword('anything', 'missing-key:')).toBe(false);
  });
});
