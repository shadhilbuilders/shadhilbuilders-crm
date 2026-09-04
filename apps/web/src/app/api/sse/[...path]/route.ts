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

/** Allow only known SSE paths — defends against an open-proxy abuse
 *  if the path is later broadened. */
function isAllowedPath(path: string): boolean {
  if (path === 'ping' || path === 'healthz' || path === 'notifications' || path === 'audit') return true;
  if (/^chat\/[^/]+$/.test(path)) return true;
  return false;
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
