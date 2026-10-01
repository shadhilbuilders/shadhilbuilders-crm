// Regression guard for the 2026-10-01 production post-login-redirect bug.
//
// better-auth names its session cookie differently per transport:
// `__Secure-better-auth.session_token` on HTTPS, the bare
// `better-auth.session_token` on HTTP. Next's cookie readers do exact-name
// lookups with NO prefix fallback, so four hand-written readers each had to
// remember both names - and proxy.ts, the one that decides the post-login
// redirect, forgot. An authenticated prod request to /login then looked
// anonymous, so the sign-in redirect replayed `307 -> /login?next=%2F`.
//
// These tests pin the shared derivation so a fifth copy cannot drift.
import { describe, expect, it } from 'vitest';

import {
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE_BASE,
  hasSessionCookie,
  readSessionCookie,
  type CookieReader,
} from './session-cookie';

/** A stand-in for Next's RequestCookies / ReadonlyRequestCookies. */
function reader(entries: Record<string, string>): CookieReader {
  const parsed = new Map(
    Object.entries(entries).map(([name, value]) => [name, { name, value }]),
  );
  return {
    get: (name) => parsed.get(name),
    getAll: () => Array.from(parsed.values()),
  };
}

describe('session-cookie', () => {
  it('names the cookie the way better-auth 1.7.2 does', () => {
    expect(SESSION_COOKIE_BASE).toBe('better-auth.session_token');
    expect(SECURE_SESSION_COOKIE).toBe('__Secure-better-auth.session_token');
  });

  it('reads the __Secure- cookie - the name production actually sets', () => {
    // The exact regression: only the prefixed name is on the request.
    const cookies = reader({ [SECURE_SESSION_COOKIE]: 'token.signature' });
    expect(readSessionCookie(cookies)?.value).toBe('token.signature');
    expect(hasSessionCookie(cookies)).toBe(true);
  });

  it('still reads the bare cookie - dev/e2e run over http', () => {
    const cookies = reader({ [SESSION_COOKIE_BASE]: 'dev-token.sig' });
    expect(readSessionCookie(cookies)?.value).toBe('dev-token.sig');
    expect(hasSessionCookie(cookies)).toBe(true);
  });

  it('prefers the secure-prefixed cookie when both are present', () => {
    // A browser that signed in over https then hit http can hold both.
    // The secure one is the live session; better-auth's own reader agrees.
    const cookies = reader({
      [SESSION_COOKIE_BASE]: 'stale.sig',
      [SECURE_SESSION_COOKIE]: 'live.sig',
    });
    expect(readSessionCookie(cookies)?.name).toBe(SECURE_SESSION_COOKIE);
    expect(readSessionCookie(cookies)?.value).toBe('live.sig');
  });

  it('reports no session when neither name is present', () => {
    expect(readSessionCookie(reader({}))).toBeNull();
    expect(hasSessionCookie(reader({}))).toBe(false);
  });

  it('does not treat an unrelated better-auth cookie as a session', () => {
    // /api/auth/session's cookie cache and `dont_remember` share the
    // `better-auth.` namespace but are not the session token. A bare
    // `startsWith('better-auth.session')` test would also match
    // `better-auth.session_data` - these must stay misses.
    const cookies = reader({
      'better-auth.session_data': 'cached',
      'better-auth.dont_remember': 'true',
    });
    expect(readSessionCookie(cookies)).toBeNull();
    expect(hasSessionCookie(cookies)).toBe(false);
  });
});
