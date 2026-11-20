// Invite token helpers (2026-11-20).
//
// Pure functions, no DB. These pin the properties the security design depends
// on: the raw token is never recoverable from what is stored, the shape guard
// rejects what could never match, and EXPIRED is DERIVED rather than written.
import { describe, expect, it } from 'vitest';

import {
  effectiveStatus,
  generateInviteToken,
  hashInviteToken,
  inviteExpiryFrom,
  looksLikeInviteToken,
} from './invites.tokens';

describe('generateInviteToken', () => {
  it('emits 32 random bytes as 43 base64url characters', () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(43);
    // base64url only - no `+` or `/`, which would need escaping in a URL path.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateInviteToken()));
    expect(set.size).toBe(200);
  });
});

describe('hashInviteToken', () => {
  it('is deterministic and 64 hex chars (sha256)', () => {
    const a = hashInviteToken('abc');
    expect(a).toBe(hashInviteToken('abc'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(hashInviteToken('a')).not.toBe(hashInviteToken('b'));
  });

  it('is not reversible-looking: the raw token never appears in the hash', () => {
    const raw = generateInviteToken();
    expect(hashInviteToken(raw)).not.toContain(raw);
  });
});

describe('looksLikeInviteToken', () => {
  it('accepts a real token', () => {
    expect(looksLikeInviteToken(generateInviteToken())).toBe(true);
  });

  it('rejects wrong lengths and characters', () => {
    // These must be refused BEFORE any DB work, so a scanner cannot use the
    // public endpoint to probe the token index with arbitrary strings.
    for (const bad of [
      '',
      'short',
      'x'.repeat(42),
      'x'.repeat(44),
      `${'x'.repeat(42)}+`, // base64 (not url) character
      `${'x'.repeat(42)}/`,
      `${'x'.repeat(42)}=`, // padding is not emitted by base64url here
      ' '.repeat(43),
    ]) {
      expect(looksLikeInviteToken(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('effectiveStatus', () => {
  const now = new Date('2026-11-20T12:00:00Z');

  it('reports PENDING while the deadline is in the future', () => {
    expect(
      effectiveStatus({ status: 'PENDING', expiresAt: new Date('2026-11-21T12:00:00Z') }, now),
    ).toBe('PENDING');
  });

  it('reports EXPIRED for a PENDING row past the deadline', () => {
    // This is the whole reason the status filter cannot be a plain column
    // match - nothing writes EXPIRED to the database.
    expect(
      effectiveStatus({ status: 'PENDING', expiresAt: new Date('2026-11-19T12:00:00Z') }, now),
    ).toBe('EXPIRED');
  });

  it('treats the deadline instant itself as expired', () => {
    expect(effectiveStatus({ status: 'PENDING', expiresAt: now }, now)).toBe('EXPIRED');
  });

  it('lets ACCEPTED and REVOKED win over the deadline', () => {
    // An invite accepted on day 6 must stay ACCEPTED on day 8 rather than
    // flipping to EXPIRED and rewriting history in the admin table.
    const stale = new Date('2026-01-01T00:00:00Z');
    expect(effectiveStatus({ status: 'ACCEPTED', expiresAt: stale }, now)).toBe('ACCEPTED');
    expect(effectiveStatus({ status: 'REVOKED', expiresAt: stale }, now)).toBe('REVOKED');
  });

  it('passes through a stored EXPIRED', () => {
    expect(
      effectiveStatus({ status: 'EXPIRED', expiresAt: new Date('2027-01-01T00:00:00Z') }, now),
    ).toBe('EXPIRED');
  });
});

describe('inviteExpiryFrom', () => {
  it('adds the TTL in days', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(inviteExpiryFrom(now, 7).toISOString()).toBe('2026-11-27T12:00:00.000Z');
  });

  it('honours a custom ttl', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(inviteExpiryFrom(now, 1).toISOString()).toBe('2026-11-21T12:00:00.000Z');
  });
});
