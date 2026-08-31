// Auth gate — Next 16 "proxy" (the renamed middleware).
//
// Behavior:
//   - No session cookie + protected path  → redirect to /login?next=<path>
//   - Session cookie + /login             → redirect to / (avoid re-login)
//   - /login, static assets, /api/auth/*  → pass through untouched
//
// Cookie presence is the gate here (cheap, edge-safe). Cryptographic
// verification happens on the API side (JwtAuthGuard / better-auth session);
// this layer exists purely for UX: bounce anonymous users to /login before
// they render a page full of failed fetches. Protected pages may still do
// their own server-side session check when they land (Phase 2).
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'better-auth.session_token';

// Prefixes that never require a session.
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/health'];

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
  // All app routes except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|css|js|woff2?)$).*)'],
};