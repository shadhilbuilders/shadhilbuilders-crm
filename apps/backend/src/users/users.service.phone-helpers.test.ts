// Pure helpers added by the user-phone slice (2026-11-18).
//
// These live in users.service.ts but carry no Nest or Prisma dependency, so
// they are tested directly here (standing repo rule: pure logic gets its own
// file and its own tests).
//
// The P2002 ATTRIBUTION is the reason this matters. Before this slice, every
// unique violation on `User` was reported as "email already exists", because
// email was the only unique constraint. Adding the partial phone index makes
// that assumption false - a duplicate phone would have sent the operator to
// fix the wrong field. `uniqueIndexFromAdapterCause` is the piece that reads
// the real constraint name; the error shape below is copied from
// @prisma/adapter-pg@7.10.0's SQLSTATE-23505 branch.
import { describe, expect, it } from 'vitest';

import { searchPhoneTerms, uniqueIndexFromAdapterCause } from './users.service';

describe('uniqueIndexFromAdapterCause', () => {
  it('reads the index name from the real driver-adapter cause shape', () => {
    // Exactly what adapter-pg produces for a 23505:
    //   { kind: 'UniqueConstraintViolation', constraint: { index }, table }
    expect(
      uniqueIndexFromAdapterCause({
        kind: 'UniqueConstraintViolation',
        constraint: { index: 'User_phone_organizationId_key' },
        table: 'User',
      }),
    ).toBe('User_phone_organizationId_key');
  });

  it('reads the EMAIL index name too - both must be distinguishable', () => {
    expect(
      uniqueIndexFromAdapterCause({
        kind: 'UniqueConstraintViolation',
        constraint: { index: 'User_email_organizationId_key' },
        table: 'User',
      }),
    ).toBe('User_email_organizationId_key');
  });

  it('returns null when only `fields` is present (no index name)', () => {
    // Postgres can report a constraint by columns instead of a name; that is
    // NOT enough to attribute the violation, so it must read as unknown rather
    // than being guessed at.
    expect(
      uniqueIndexFromAdapterCause({
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['phone', 'organizationId'] },
      }),
    ).toBeNull();
  });

  it('returns null for a bare string constraint (the shape the old code assumed)', () => {
    // Guards the exact regression: `constraint` used to be compared as a
    // string. It is an object now, so a naive === comparison would silently
    // never match and every P2002 would fall through to the generic branch.
    expect(uniqueIndexFromAdapterCause({ constraint: 'User_phone_organizationId_key' })).toBeNull();
  });

  it('returns null for undefined / null / junk', () => {
    expect(uniqueIndexFromAdapterCause(undefined)).toBeNull();
    expect(uniqueIndexFromAdapterCause(null)).toBeNull();
    expect(uniqueIndexFromAdapterCause('nope')).toBeNull();
    expect(uniqueIndexFromAdapterCause({})).toBeNull();
  });
});

describe('searchPhoneTerms', () => {
  it('keeps a bare 10-digit number as-is AND adds the normalized form', () => {
    // Both, because "9876543210" must match the stored "919876543210"
    // (prefix-normalized) and a raw contains on the digits.
    expect(searchPhoneTerms('9876543210').sort()).toEqual(['919876543210', '9876543210']);
  });

  it('strips formatting from a typed number', () => {
    const terms = searchPhoneTerms('98765 43210');
    expect(terms).toContain('9876543210');
    expect(terms).toContain('919876543210');
  });

  it('handles a +91 prefix', () => {
    const terms = searchPhoneTerms('+91 98765 43210');
    expect(terms).toContain('919876543210');
  });

  it('handles a leading 0 (the Indian trunk prefix)', () => {
    const terms = searchPhoneTerms('098765 43210');
    expect(terms).toContain('919876543210');
  });

  it('a PARTIAL digit run is never normalized into a different number', () => {
    // "7654" must stay "7654" so it matches mid-string. Normalizing it would
    // either throw or rewrite it into a full number that matches nothing.
    const terms = searchPhoneTerms('7654');
    expect(terms).toContain('7654');
    expect(terms.every((t) => t.length <= 4)).toBe(true);
  });

  it('a name query contributes no phone terms (avoids a false 500)', () => {
    // Non-digit input must not throw: the search box is a half-typed string.
    expect(() => searchPhoneTerms('Priya')).not.toThrow();
    expect(searchPhoneTerms('Priya')).toEqual([]);
  });

  it('never throws on unparseable input', () => {
    for (const q of ['', '-', 'abc', '!!!', '*', '+']) {
      expect(() => searchPhoneTerms(q)).not.toThrow();
    }
  });

  it('deduplicates when raw and normalized are identical', () => {
    // A 12-digit value that is already normalized: no duplicate terms.
    expect(searchPhoneTerms('919876543210')).toEqual(['919876543210']);
  });
});
