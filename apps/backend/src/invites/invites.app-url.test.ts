// Invite link ORIGIN resolution (2026-11-20).
//
// Regression test for a bug reported live: every generated link pointed at
// `http://localhost:8080/invite/<token>` - the API - and 404'd, because the
// implementation derived the origin from BETTER_AUTH_URL, which in this
// project's dev env is the API, not the web app. In production the split is
// `api.crm...` vs `crm...`, so the same mistake would have mailed every staff
// member a dead link.
//
// These cases pin the resolution ORDER, because the failure mode was a
// plausible-but-wrong source winning silently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

import { PrismaService } from '../prisma/prisma.module';
import { buildInviteUrl } from './invites.links';
import { InvitesService } from './invites.service';

// The service reads env at call time, so each case can swap the environment.
const KEYS = ['APP_URL', 'NEXT_PUBLIC_APP_URL', 'CORS_ORIGINS', 'BETTER_AUTH_URL', 'API_PORT'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Reach the private getter without exporting it for tests. */
function appUrlOf(service: InvitesService): string {
  return (service as unknown as { appUrl: string }).appUrl;
}

function makeService(): InvitesService {
  return new InvitesService({ $client: null } as unknown as PrismaService);
}

describe('invite link origin - resolution order', () => {
  it('prefers APP_URL (the explicit answer)', () => {
    process.env['APP_URL'] = 'https://crm.shadhilbuilders.in';
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://ignored.example';
    expect(appUrlOf(makeService())).toBe('https://crm.shadhilbuilders.in');
  });

  it('falls back to NEXT_PUBLIC_APP_URL (the web app’s own canonical origin)', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'http://localhost:3000';
    expect(appUrlOf(makeService())).toBe('http://localhost:3000');
  });

  it('falls back to the first CORS origin (the web origin in dev)', () => {
    process.env['CORS_ORIGINS'] = 'http://localhost:3000,http://localhost:8081';
    expect(appUrlOf(makeService())).toBe('http://localhost:3000');
  });

  it('uses BETTER_AUTH_URL when it is NOT the API port', () => {
    // e.g. a deployment where better-auth is served from the web origin.
    process.env['BETTER_AUTH_URL'] = 'https://crm.shadhilbuilders.in';
    process.env['API_PORT'] = '8080';
    expect(appUrlOf(makeService())).toBe('https://crm.shadhilbuilders.in');
  });

  // ── The actual bug ──────────────────────────────────────────────────────
  it('REFUSES to use BETTER_AUTH_URL when it points at the API port', () => {
    // This is the dev env that produced the dead links. Falling through to a
    // throw is correct: a link to the API 404s, so failing loudly at create
    // time is strictly better than sending staff to a dead host.
    process.env['BETTER_AUTH_URL'] = 'http://localhost:8080';
    process.env['API_PORT'] = '8080';
    expect(() => appUrlOf(makeService())).toThrow(/APP_URL/);
  });

  it('refuses when nothing identifies a web origin', () => {
    expect(() => appUrlOf(makeService())).toThrow(/APP_URL/);
  });

  it('never returns the API origin in the dev configuration that broke', () => {
    // The exact documented dev env, minus the fix: if this ever returns a
    // :8080 URL again, the bug is back.
    process.env['BETTER_AUTH_URL'] = 'http://localhost:8080';
    process.env['API_PORT'] = '8080';
    process.env['CORS_ORIGINS'] = 'http://localhost:3000,http://localhost:8081';
    const url = appUrlOf(makeService());
    expect(url).toBe('http://localhost:3000');
    expect(url).not.toContain(':8080');
  });
});

describe('buildInviteUrl strips trailing slashes', () => {
  it('does not produce a double slash', () => {
    // Imported statically: `nest build` type-checks this file, and a dynamic
    // `await import('./invites.links')` failed the build with TS2307 while
    // vitest resolved it fine - the test passed and the server would not start.
    expect(buildInviteUrl('http://localhost:3000/', 'tok')).toBe(
      'http://localhost:3000/invite/tok',
    );
    expect(createId().length).toBeGreaterThan(0);
  });
});
