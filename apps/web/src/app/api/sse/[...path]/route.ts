// BFF SSE proxy — streams ticket-authenticated SSE from the
// standalone realtime-sse service to the browser.
//
// Why a separate route: /api/bff/[...path] is a JSON-only proxy
// (it awaits `upstream.text()` before responding), so it can't
// carry the open SSE connection. This route does the minimal
// session-verify (same as the JSON BFF) and then opens a raw
// fetch ReadableStream and pipes it through NextResponse so the
// connection stays open end-to-end.
//
// Topology:
//   browser ── /api/sse/* ── BFF (this file) ── :8090/api/sse/*
//   (browser)               (Next.js route)    (apps/realtime-sse)
//
// The SSE service owns ticket consume + DB polling. The BFF just
// passes bytes through — it never reads the ticket.

import { cookies } from 'next/headers';
import { type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'better-auth.session_token';
const SSE_BACKEND_URL = process.env.SSE_BACKEND_URL ?? 'http://localhost:8090';

// T-PERF-2 #2: Origin allowlist. Defends against a foreign origin driving
// the BFF into opening proxy connections. Default is the two dev origins
// (web on :3000, Expo on :8081). In prod, set ALLOWED_SSE_ORIGINS to a
// comma-separated list like
// 'https://crm.shadhilbuilders.in,https://admin.crm.shadhilbuilders.in'.
const ALLOWED_SSE_ORIGINS = (process.env.ALLOWED_SSE_ORIGINS ?? 'http://localhost:3000,http://localhost:8081')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** Allow only known SSE paths — defends against an open-proxy abuse
 *  if the path is later broadened. */
function isAllowedPath(path: string): boolean {
  if (path === 'ping' || path === 'healthz' || path === 'metrics' || path === 'notifications' || path === 'audit') return true;
  if (/^chat\/[^/]+$/.test(path)) return true;
  return false;
}

/** Reject the request if the Origin header is present and not in the
 *  allowlist. Absent Origin is allowed (curl, server-to-server).
 *  Returns null on pass, a Response on fail. */
function checkOrigin(origin: string | null): Response | null {
  if (origin === null) return null;
  if (ALLOWED_SSE_ORIGINS.includes(origin)) return null;
  return new Response(
    JSON.stringify({ message: 'Origin not allowed' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const joined = path.join('/');
  if (!isAllowedPath(joined)) {
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // T-PERF-2 #2: Origin allowlist check (BEFORE session check, so
  // unauthenticated probes from foreign origins get 403 not 401 —
  // we don't want to reveal whether a session exists at this origin).
  const originRejection = checkOrigin(request.headers.get('origin'));
  if (originRejection !== null) return originRejection;

  // Session check: the SSE service authenticates the ticket, not the
  // session, but the BFF still needs the user to be signed in (the
  // ticket mint endpoint is JWT-gated on the backend, and we don't
  // want a path that lets unauthenticated browsers open SSE streams).
  const cookieStore = await cookies();
  const cookieValue =
    cookieStore.get(SESSION_COOKIE)?.value ??
    cookieStore.getAll().find((c) => c.name.startsWith(SESSION_COOKIE))?.value ??
    null;
  if (cookieValue === null) {
    return new Response(JSON.stringify({ message: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const target = new URL(`/api/sse/${joined}${request.nextUrl.search}`, SSE_BACKEND_URL);
  const upstream = await fetch(target, {
    method: 'GET',
    headers: {
      // Forward the Origin so the SSE service's CORS check still
      // sees the original caller (matches the JSON BFF's behavior).
      Origin: request.headers.get('origin') ?? '',
    },
    cache: 'no-store',
    // Disable Node's fetch buffering so frames flush as they arrive.
    // Next.js 15 honors this on the Response side.
  });

  if (upstream.body === null) {
    return new Response('upstream returned no body', { status: 502 });
  }

  // Pass through the status + headers (filtering hop-by-hop headers
  // is unnecessary; the SSE service only sets Content-Type,
  // Cache-Control, Connection, X-Accel-Buffering, all of which are
  // safe to forward).
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    if (key.toLowerCase() === 'transfer-encoding') return;
    headers.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
