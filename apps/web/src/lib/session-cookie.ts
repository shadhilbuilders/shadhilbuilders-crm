// The better-auth session cookie NAME, resolved for the current transport.
//
// Why this module exists (2026-10-01, prod post-login-redirect bug):
//
//   better-auth 1.7.2 prefixes the session cookie with `__Secure-` whenever
//   its baseURL is https (RFC 6265bis):
//
//     // better-auth/dist/cookies/index.mjs
//     secureCookiePrefix = (useSecureCookies !== undefined ? useSecureCookies
//       : dynamicProtocol === 'https' ? true
//       : baseURLString ? baseURLString.startsWith('https://')
//       : isProduction) ? '__Secure-' : ''
//
//   So production sets `__Secure-better-auth.session_token` while dev/e2e
//   (http) sets the bare `better-auth.session_token`. Both names are real
//   and must be honored, secure-prefixed FIRST.
//
//   On the SERVER, better-auth's own reader does exactly this fallback:
//
//     // better-auth/dist/cookies/index.mjs:266
//     const getCookie = (name) => parsedCookie.get(`__Secure-${name}`) ?? parsedCookie.get(name);
//
//   Nothing outside better-auth does it for us. Next's `cookies()` and
//   `request.cookies` are plain exact-name maps with NO fallback:
//
//     // next/dist/compiled/@edge-runtime/cookies
//     has(name) { return this._parsed.has(name); }
//     get(name) { return this._parsed.get(name); }
//
//   so every hand-written lookup that hardcoded the plain name silently
//   missed the production cookie. That bug shipped four separate times
//   (BFF route, SSE route, tenant.ts - all fixed in ab020cd - and
//   proxy.ts, which ab020cd missed, breaking the post-login redirect).
//
// ONE derivation, imported by every server-side reader. Do NOT reintroduce
// a local `const SESSION_COOKIE = 'better-auth.session_token'` - a second
// copy is what let one of the four sites keep the bug.
//
// Note this module is NOT marked `server-only`: `proxy.ts` (Next's edge
// middleware) is not covered by the `react-server` export condition, so a
// `server-only` import would fail its bundle. Keep it dependency-free.

/** better-auth's cookie base name, without any `__Secure-` prefix. */
export const SESSION_COOKIE_BASE = 'better-auth.session_token';

/** RFC 6265bis prefix better-auth applies on HTTPS origins. */
export const SECURE_COOKIE_PREFIX = '__Secure-';

/** The secure-prefixed sibling of the session cookie (the production name). */
export const SECURE_SESSION_COOKIE = `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASE}`;

/** The minimal read surface shared by Next's `cookies()` and `request.cookies`. */
export type CookieReader = {
  get(name: string): { name: string; value: string } | undefined;
  getAll(): { name: string; value: string }[];
};

/**
 * The session cookie present on this request, secure-prefixed name first.
 * `null` when the request carries no session cookie at all.
 *
 * Use this for ANY server-side session-cookie read. Prefer it over a bare
 * `has()`: a request can also carry `/api/auth/session`'s cookie cache or a
 * stale `better-auth.dont_remember`, so "some cookie named like this" is a
 * weaker question than "the session token is here".
 */
export function readSessionCookie(
  cookies: CookieReader,
): { name: string; value: string } | null {
  return (
    cookies.get(SECURE_SESSION_COOKIE) ??
    cookies.get(SESSION_COOKIE_BASE) ??
    null
  );
}

/**
 * True when the request carries a session cookie under EITHER name. The
 * boolean form - for gates that only need presence (e.g. proxy.ts is an
 * edge runtime: it reads cookie presence, never the value).
 */
export function hasSessionCookie(cookies: CookieReader): boolean {
  return readSessionCookie(cookies) !== null;
}
