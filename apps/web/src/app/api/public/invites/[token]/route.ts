// Public invite routes - thin proxy to NestJS.
//
// WHY THIS EXISTS. The accept form runs in the BROWSER, and the invitee has no
// session, so neither the BFF (`/api/bff/*`, which mints a JWT from the
// session cookie) nor a direct call to BACKEND_API_URL is available:
//   * the BFF would 401 - there is no cookie to bridge;
//   * BACKEND_API_URL is a SERVER-side origin, unreachable from the browser.
// So the browser talks to this same-origin route and this handler forwards to
// NestJS with no Authorization header. The invite TOKEN in the path is the
// credential, which is exactly the backend's @Public() contract for these two
// routes.
//
// This is a pass-through with no logic of its own: status and body are relayed
// verbatim so the backend's coded 404/409/410 reach the form unchanged.
import { type NextRequest, NextResponse } from 'next/server';

import { env } from '@/lib/env/env';

export const dynamic = 'force-dynamic';

async function forward(
  request: NextRequest,
  path: string,
  params: Promise<{ token: string }>,
): Promise<NextResponse> {
  const { token } = await params;
  const target = new URL(path.replace(':token', encodeURIComponent(token)), env.BACKEND_API_URL);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      // Only POST carries a body; GET must not send one.
      body: request.method === 'GET' ? undefined : await request.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // An outage must not masquerade as "bad invite".
    return NextResponse.json(
      { code: 'INVITE_UNAVAILABLE', message: 'Could not reach the server. Please try again.' },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

/**
 * GET  /api/public/invites/[token]        - preview (browser retry path)
 * POST /api/public/invites/[token]        - accept
 *
 * The accept POST lives on the SAME dynamic segment rather than a nested
 * `/accept` folder: one proxy, one file, and the backend path is what differs.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  return forward(request, '/api/public/invites/:token', ctx.params);
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  return forward(request, '/api/public/invites/:token/accept', ctx.params);
}
