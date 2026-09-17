// Tests for the test-database isolation helper (T-TEST-DB-ISOLATION, 2026-09-16).
//
// These exist because the FIRST version of this helper was wrong in a way that
// made the security matrix pass while enforcing nothing: it pointed
// `DATABASE_URL` (role `shadhil_app`, RLS ENFORCED) at `DIRECT_DATABASE_URL`
// (role `shadhil`, the table owner, BYPASSRLS). Every policy stopped applying, so
// a MANAGER could read both fixture leads instead of one - a green security suite
// that tested nothing. The role must survive the rewrite; these pin that.

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertTestDatabase,
  databaseNameOf,
  isolateTestDatabase,
  portOf,
  shouldRedirect,
  toTestDatabaseUrl,
} from '../src/test-db-isolation';

const APP_URL =
  'postgresql://shadhil_app:appsecret@localhost:6432/shadhil_crm?schema=public';
const OWNER_URL =
  'postgresql://shadhil:ownersecret@localhost:5432/shadhil_crm?schema=public';

describe('toTestDatabaseUrl', () => {
  it('swaps only the database name, preserving role, password, host and query', () => {
    const out = toTestDatabaseUrl(APP_URL, '5432');
    expect(databaseNameOf(out)).toBe('shadhil_crm_test');
    // The ROLE must survive - this is the regression that broke RLS.
    expect(out).toContain('shadhil_app:appsecret@');
    expect(out).toContain('localhost');
    expect(out).toContain('schema=public');
  });

  it('moves the pooled URL off PgBouncer but keeps the direct URL on its port', () => {
    // PgBouncer only routes `shadhil_crm`, so the pooled port must become the
    // direct postgres port or every query fails "no such database".
    expect(portOf(toTestDatabaseUrl(APP_URL, '5432'))).toBe('5432');
    // The owner URL is already direct - its own port is preserved.
    expect(portOf(toTestDatabaseUrl(OWNER_URL))).toBe('5432');
  });

  it('never confuses the two roles', () => {
    const app = toTestDatabaseUrl(APP_URL, '5432');
    const owner = toTestDatabaseUrl(OWNER_URL, '5432');
    expect(app).not.toBe(owner);
    expect(app).not.toContain('shadhil:ownersecret');
    expect(owner).not.toContain('shadhil_app:appsecret');
  });
});

describe('databaseNameOf / portOf', () => {
  it('reads the name and port', () => {
    expect(databaseNameOf(APP_URL)).toBe('shadhil_crm');
    expect(portOf(APP_URL)).toBe('6432');
  });

  it('returns empty strings for an unparseable URL rather than throwing', () => {
    expect(databaseNameOf('not a url')).toBe('');
    expect(portOf('not a url')).toBe('');
  });
});

describe('assertTestDatabase', () => {
  it('accepts a _test database', () => {
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/shadhil_crm_test', 'DATABASE_URL'),
    ).not.toThrow();
  });

  it('refuses the DEVELOPMENT database', () => {
    // The whole point: a rewrite that silently fails must not fall through to dev.
    expect(() => assertTestDatabase(APP_URL, 'DATABASE_URL')).toThrow(/_test database/);
  });

  it('refuses an unparseable URL', () => {
    expect(() => assertTestDatabase('', 'DATABASE_URL')).toThrow();
    expect(() => assertTestDatabase('???', 'DATABASE_URL')).toThrow(/_test database/);
  });
});

describe('shouldRedirect', () => {
  it('rewrites a dev URL and leaves an already-test URL alone', () => {
    expect(shouldRedirect(APP_URL)).toBe(true);
    expect(shouldRedirect('postgresql://u:p@localhost:5432/shadhil_crm_test')).toBe(false);
  });

  it('ignores an unset or empty URL', () => {
    expect(shouldRedirect(undefined)).toBe(false);
    expect(shouldRedirect('')).toBe(false);
  });

  describe('TEST_DB_ALLOW_DEV opt-out', () => {
    afterEach(() => {
      delete process.env['TEST_DB_ALLOW_DEV'];
    });

    it('disables the rewrite and the assertion when set to 1', () => {
      process.env['TEST_DB_ALLOW_DEV'] = '1';
      // The e2e job drives the real app against a dev-shaped database and must
      // not be redirected - but opting out is EXPLICIT so "I meant dev" can never
      // be confused with "isolation silently failed".
      expect(shouldRedirect(APP_URL)).toBe(false);
      expect(() => assertTestDatabase(APP_URL, 'DATABASE_URL')).not.toThrow();
    });

    it('leaves the vars untouched when opted out', () => {
      process.env['TEST_DB_ALLOW_DEV'] = '1';
      process.env['DATABASE_URL'] = APP_URL;
      process.env['DIRECT_DATABASE_URL'] = OWNER_URL;
      isolateTestDatabase();
      expect(process.env['DATABASE_URL']).toBe(APP_URL);
      expect(process.env['DIRECT_DATABASE_URL']).toBe(OWNER_URL);
      delete process.env['DATABASE_URL'];
      delete process.env['DIRECT_DATABASE_URL'];
    });
  });
});
