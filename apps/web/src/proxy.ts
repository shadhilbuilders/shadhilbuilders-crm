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
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'better-auth.session_token';

// Prefixes that never require a session. PWA files (manifest, sw.js, the
// /icons/* brand assets, and the offline page) must be public so
// Lighthouse + service workers can fetch them without a session cookie.
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/api/health',
  '/icons',         // PWA brand assets (icon-192, icon-512, maskable-512, apple-touch-180)
  '/brand',         // brand logo assets - rendered on the unauthenticated auth top bar (/login etc.)
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
    if (pathname === '/login' && request.cookies.has(SESSION_COOKIE)) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!request.cookies.has(SESSION_COOKIE)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
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
    '/((?!api|_next/static|_next/image|favicon\\.ico|icons|brand|login|manifest\\.webmanifest|manifest\\.json|offline|sw\\.js|workbox-).*)',
  ],
};
