// Auth gate — Next 16 "proxy" (the renamed middleware).
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

// Prefixes that never require a session. PWA files (manifest, sw.js) and
// the offline page must be public so Lighthouse + service workers can
// fetch them without a session cookie.
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/api/health',
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
  // Match all app routes except Next internals. PWA paths
  // (manifest, sw.js, /offline) are handled by the explicit
  // PUBLIC_PATHS check in the function body — the previous regex
  // tried to match static assets by file extension but the `.*` was
  // greedy and caught /manifest.webmanifest too. Static asset paths
  // like /icons/*.png and /_next/static/* are served by Next 16's
  // edge before the proxy runs, so we don't need to skip them here.
  //
  // Note: Next 16's proxy matcher uses path-to-regexp, which does NOT
  // support PCRE negative-lookahead `(?!...)`. We use an explicit
  // positive list of protected app routes instead — the public paths
  // (PWA files, /login, /api/*) fall through to Next's static +
  // route handling and never reach the proxy function.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon\\.ico|login|manifest\\.webmanifest|manifest\\.json|offline|sw\\.js|workbox-).*)',
  ],
};
