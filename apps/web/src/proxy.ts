// Auth gate - Next 16 "proxy" (the renamed middleware).
//
// Behavior:
//   - No session cookie + protected path  → redirect to /login?next=<path>
//   - Session cookie + /login             → redirect to / (avoid re-login)
//   - /login, static assets, PWA files, /api/auth/*  → pass through untouched
//
// Cookie presence is the gate here (cheap, edge-safe). Cryptographic
// verification happens on the API side (JwtAuthGuard / better-auth session);
// this layer exists purely for UX: bounce anonymous users to /login before
// they render a page full of failed fetches. Protected pages may still do
// their own server-side session check when they land (Phase 2).
//
// COOKIE NAME (2026-10-01): this gate must test BOTH better-auth cookie
// names - `__Secure-better-auth.session_token` (HTTPS, i.e. production) and
// the bare `better-auth.session_token` (HTTP, dev/e2e). See
// lib/session-cookie.ts for the full derivation and the incident history.
//
// This file was the LAST of four hand-written lookups to carry the bug:
// ab020cd fixed the BFF route, the SSE route and tenant.ts but missed the
// gate that actually decides the post-login redirect. Tested as a plain
// `cookieStore.has('better-auth.session_token')`, an authenticated
// production request to `/login` looked anonymous and was passed through,
// so the post-sign-in `window.location.assign('/')` replayed the anonymous
// `307 -> /login?next=%2F` instead of entering the app.
import { type NextRequest, NextResponse } from 'next/server';

import { hasSessionCookie } from '@/lib/session-cookie';

// Prefixes that never require a session. PWA files (manifest, sw.js, the
// /icons/* brand assets, and the offline page) must be public so
// Lighthouse + service workers can fetch them without a session cookie.
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/api/health',
  // Staff invite acceptance (2026-11-20). A staff member opening their invite
  // has NO session - the token in the path is the credential. Without this
  // entry the gate bounces them to /login?next=/invite/... and the whole flow
  // is unreachable. See the matcher for the second half of this fix.
  '/invite',
  '/api/public/invites',
  // Phone-or-email login resolver (2026-11-21). Same reason: it runs before a
  // session exists and the browser has to reach a same-origin URL.
  '/api/public/auth',
  '/icons', // PWA brand assets (icon-192, icon-512, maskable-512, apple-touch-180)
  '/cmda-plan.svg', // approved plot-layout artwork: the SW precaches it from /login with no session, so it must never redirect to /login
  '/brand', // brand logo assets - rendered on the unauthenticated auth top bar (/login etc.)
  '/manifest.webmanifest',
  '/manifest.json',
  '/offline',
  '/sw.js',
  '/workbox-', // Workbox-generated helper scripts (in case any are added later)
];

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Signed-in user hitting /login → send them to the app.
    if (pathname === '/login' && hasSessionCookie(request.cookies)) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!hasSessionCookie(request.cookies)) {
    const loginUrl = new URL('/login', request.url);
    // PATHNAME **AND QUERY** (2026-11-23). Saving only the pathname silently
    // dropped every query-dependent destination: a buyer opening a WhatsApp
    // site-update link (`/portal?photo=<id>`) landed on the portal's default
    // unit instead of their update, because `?photo=` never survived the login
    // bounce. `search` already begins with '?', so it is appended verbatim.
    loginUrl.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Match all app routes except Next internals + public PWA assets. PWA
  // paths (manifest, sw.js, /offline, /icons/*) are also handled by the
  // explicit PUBLIC_PATHS check in the function body - both layers exist
  // for defense-in-depth: the matcher is the cheap edge-runtime gate, the
  // function body is the explicit allowlist that survives any future
  // matcher-regex refactor.
  //
  // Static asset paths like /_next/static/* are served by Next 16's edge
  // before the proxy runs, so they only need the matcher exclusion, not
  // the function body list. /icons/* is the exception: Next 16 does NOT
  // short-circuit /public/* before the proxy runs, so /icons/*.png DOES
  // reach the proxy and needs both layers of exclusion.
  //
  // Note: Next 16's proxy matcher uses the platform URLPattern API
  // (Web Platform URL Pattern, supported in modern Node + Edge runtimes),
  // which DOES support PCRE negative-lookahead `(?!...)`. The matcher
  // above compiles to a URLPattern whose pathname regex skips everything
  // inside the lookahead, so `/icons/icon-192.png`, `/sw.js`, and other
  // public PWA paths never reach the proxy function.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon\\.ico|icons|brand|cmda-plan\\.svg|login|invite|manifest\\.webmanifest|manifest\\.json|offline|sw\\.js|workbox-).*)',
  ],
};
