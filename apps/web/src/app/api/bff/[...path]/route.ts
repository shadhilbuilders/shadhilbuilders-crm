// BFF proxy to the NestJS backend - server-side JWT bridge.
//
// Why this exists (DESIGN.md §8): server components and route handlers don't
// automatically carry a JWT; the browser holds only the better-auth session
// cookie. A browser call to /api/bff/* passes that cookie here; this handler
// verifies the session against the DB, mints the shared-secret HS256 JWT via
// issueJwt() from @shadhil/auth (same claim shape better-auth's jwt() plugin
// emits - NestJS verifyJwt accepts both), forwards the request to NestJS,
// and streams the response back (byte ranges included: see relayResponse).
//
// Client hooks in src/apis/* call /api/bff/* exclusively, so no browser code
// ever handles a raw JWT.
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

import { issueJwt } from '@shadhil/auth';
import { prisma } from '@shadhil/database';

import { buildBackendPath } from '@/lib/bff-path';
import { readSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

export async function POST(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

export async function DELETE(request: NextRequest, ctx: RouteContext<'/api/bff/[...path]'>) {
  return forward(request, ctx);
}

async function forward(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const backendPath = buildBackendPath(path);

  // better-auth's cookie value is `<token>.<hmac>` - the DB `Session.token`
  // column stores the bare token part only. Strip the signature before the
  // lookup, then URL-decode (the cookie value arrives percent-encoded).
  const cookieStore = await cookies();
  const cookieValue = readSessionCookie(cookieStore)?.value ?? null;
  if (cookieValue === null) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }
  let sessionToken: string | null;
  try {
    const decoded = decodeURIComponent(cookieValue);
    sessionToken = decoded.split('.')[0] ?? null;
  } catch {
    sessionToken = cookieValue.split('.')[0] ?? null;
  }
  if (sessionToken === null || sessionToken.length === 0) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const session = await prisma.session.findFirst({
    where: { token: sessionToken },
    select: {
      expiresAt: true,
      user: {
        select: {
          id: true,
          role: true,
          organizationId: true,
          email: true,
        },
      },
    },
  });
  if (session === null || session.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ message: 'Session expired' }, { status: 401 });
  }

  const jwt = await issueJwt({
    sub: session.user.id,
    role: session.user.role,
    organizationId: session.user.organizationId,
    email: session.user.email,
  });

  const backendUrl = process.env.BACKEND_API_URL ?? 'http://localhost:8080';
  const incoming = new URL(request.url);
  const target = new URL(`/api/${backendPath}${incoming.search}`, backendUrl);

  const upstream = await fetch(target, {
    method: request.method,
    headers: buildUpstreamHeaders(request, jwt),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    cache: 'no-store',
    // A seek or a closed tab aborts the browser request; without this the old
    // range keeps downloading from the backend for nothing.
    signal: request.signal,
  });

  return relayResponse(upstream);
}

/** Headers the browser sent that the backend needs to answer a byte range. */
const FORWARDED_REQUEST_HEADERS = ['range', 'if-range'] as const;

function buildUpstreamHeaders(request: NextRequest, jwt: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': request.headers.get('content-type') ?? 'application/json',
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null)
      headers[name.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase())] = value;
  }
  return headers;
}

/** Response headers worth relaying: what a <video> element needs to seek and cache correctly. */
const RELAYED_RESPONSE_HEADERS = [
  'content-range',
  'accept-ranges',
  'content-disposition',
  'etag',
  'last-modified',
] as const;

/** Statuses that must not carry a body (a Response constructed with one throws). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * Relay the upstream response without buffering it: a 14 MiB clip streams
 * through in chunks, and 206/Content-Range survive. `Cache-Control` stays
 * `no-store` - media is per-user and reached through short-lived signed reads.
 */
function relayResponse(upstream: Response): NextResponse {
  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    'Cache-Control': 'no-store',
  });
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // fetch() has already decoded a content-encoded body, so the upstream length
  // would be wrong for the bytes we send. Only relay it for identity encoding.
  const length = upstream.headers.get('content-length');
  if (length !== null && !upstream.headers.has('content-encoding')) {
    headers.set('Content-Length', length);
  }

  if (NULL_BODY_STATUSES.has(upstream.status)) {
    headers.delete('Content-Type');
    return new NextResponse(null, { status: upstream.status, headers });
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
