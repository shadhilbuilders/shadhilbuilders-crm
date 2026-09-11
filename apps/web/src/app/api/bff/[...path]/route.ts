// BFF proxy to the NestJS backend - server-side JWT bridge.
//
// Why this exists (DESIGN.md §8): server components and route handlers don't
// automatically carry a JWT; the browser holds only the better-auth session
// cookie. A browser call to /api/bff/* passes that cookie here; this handler
// verifies the session against the DB, mints the shared-secret HS256 JWT via
// issueJwt() from @shadhil/auth (same claim shape better-auth's jwt() plugin
// emits - NestJS verifyJwt accepts both), forwards the request to NestJS,
// and streams the JSON back.
//
// Client hooks in src/apis/* call /api/bff/* exclusively, so no browser code
// ever handles a raw JWT.
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

import { issueJwt } from '@shadhil/auth';
import { prisma } from '@shadhil/database';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'better-auth.session_token';

export async function GET(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
) {
  return forward(request, ctx);
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
) {
  return forward(request, ctx);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
) {
  return forward(request, ctx);
}

export async function PUT(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
) {
  return forward(request, ctx);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
) {
  return forward(request, ctx);
}

async function forward(
  request: NextRequest,
  ctx: RouteContext<'/api/bff/[...path]'>,
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const backendPath = path.join('/');

  // better-auth's cookie value is `<token>.<hmac>` - the DB `Session.token`
  // column stores the bare token part only. Strip the signature before the
  // lookup, then URL-decode (the cookie value arrives percent-encoded).
  const cookieStore = await cookies();
  const cookieValue =
    cookieStore.get(SESSION_COOKIE)?.value ??
    cookieStore
      .getAll()
      .find((c) => c.name.startsWith(SESSION_COOKIE))?.value ??
    null;
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
          teamId: true,
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
    teamId: session.user.teamId,
    organizationId: session.user.organizationId,
    email: session.user.email,
  });

  const backendUrl = process.env.BACKEND_API_URL ?? 'http://localhost:8080';
  const incoming = new URL(request.url);
  const target = new URL(`/api/${backendPath}${incoming.search}`, backendUrl);

  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': request.headers.get('content-type') ?? 'application/json',
    },
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.text(),
    cache: 'no-store',
  });

  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}