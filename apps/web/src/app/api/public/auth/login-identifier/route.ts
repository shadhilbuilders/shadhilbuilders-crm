// BFF proxy for the public login resolver (2026-11-21).
//
// WHY: the resolver runs before anyone has a session, so neither the BFF
// (`/api/bff/*` mints a JWT from the cookie) nor BACKEND_API_URL from the
// browser is available. This route is same-origin, forwards the body verbatim,
// and relays the backend's status and body unchanged.
//
// X-Forwarded-For is passed through deliberately: the backend rate-limits this
// route per client IP with @nestjs/throttler, and without the header every login
// attempt would arrive from this web server's address - one shared bucket for
// every person using the app, so ten mistakes across the whole team would lock
// the endpoint for everyone.
import { type NextRequest, NextResponse } from 'next/server';

import { env } from '@/lib/env/env';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const target = new URL('/api/public/auth/login-identifier', env.BACKEND_API_URL);
  const forwardedFor =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(forwardedFor.length > 0 ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      body: await request.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // An outage must not read as "wrong password".
    return NextResponse.json(
      { code: 'LOGIN_UNAVAILABLE', message: 'Could not reach the server. Please try again.' },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
