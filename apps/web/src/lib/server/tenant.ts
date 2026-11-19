// Server-only data helpers for the slug-based layouts.
//
// The async OrganizationLayout / project layout are SERVER components: they
// must resolve a `[orgSlug]` / `[projectSlug]` URL segment to the tenant id
// BEFORE rendering children (so pages keep using id-keyed hooks/APIs via
// context). Resolving requires an authenticated backend call, so this
// module reuses the exact session→JWT→NestJS bridge the BFF route uses
// (see app/api/bff/[...path]/route.ts):
//   1. read the better-auth session cookie,
//   2. look up the Session row (DB), mint the shared-secret JWT via issueJwt,
//   3. GET /api/<endpoint> on the NestJS backend with that JWT.
//
// Imported ONLY from server components / route handlers. Pulling it from a
// client component drags the @shadhil/database server chain into the
// browser bundle and crashes the build ("Module not found: pg").
//
// WHY THE RESULT IS A UNION, NOT `T | null` (2026-11-19): this module used to
// return `null` for EVERY failure - no session, RLS refusal, backend 5xx,
// backend unreachable - and the layouts turned `null` into `notFound()`. So
// a signed-in user with a stale session cookie got "Page not found" on
// `/[orgSlug]/settings` (a page that exists) instead of the sign-in screen.
// Callers now get the failure CLASS and decide: unauthenticated → /login,
// rotation gate → /change-password, forbidden/absent → 404, outage → error
// boundary. See lib/tenant-failure.ts for the mapping and its rationale.
import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { issueJwt } from '@shadhil/auth';
import { prisma } from '@shadhil/database';

import { env } from '@/lib/env';
import { readSessionCookie } from '@/lib/session-cookie';
import { classifyBackendFailure, type TenantFailure } from '@/lib/tenant-failure';

/** Shape of GET /organizations/by-slug/:slug. */
export type OrgLookup = { id: string; name: string; slug: string };
/** Shape of GET /organizations/projects/by-slug/:slug. */
export type ProjectLookup = { id: string; slug: string; name: string };

/** A resolved tenant, or the precise reason it could not be resolved. */
export type TenantResult<T> = { ok: true; data: T } | { ok: false; failure: TenantFailure };

const UNAUTHENTICATED: TenantFailure = { kind: 'unauthenticated' };

/**
 * How long a tenant lookup may take before it is reported as unavailable.
 *
 * Without this, a backend that ACCEPTS the connection but never answers (a
 * hung process, a saturated pool, a half-open load-balancer socket) made the
 * org layout - and therefore EVERY org-scoped page - hang indefinitely: the
 * user got a blank page and no retry. Verified by SIGSTOPping the backend
 * against the dev server. A timeout turns that into the same retryable error
 * surface as a refused connection.
 *
 * Sized well above a healthy lookup (observed ~60-200ms locally) so a slow
 * but working backend is never cut off, and below the point where a browser
 * or proxy would give up on the page anyway.
 */
const TENANT_LOOKUP_TIMEOUT_MS = 8_000;

/**
 * Mint a backend JWT for the current request's session. Returns the failure
 * instead of throwing, because "no session" is an ordinary state for a page
 * the proxy let through (the cookie is present but the row is gone/expired).
 */
async function backendJwt(): Promise<
  { ok: true; jwt: string } | { ok: false; failure: TenantFailure }
> {
  const cookieStore = await cookies();
  const cookieValue = readSessionCookie(cookieStore)?.value ?? null;
  if (cookieValue === null) return { ok: false, failure: UNAUTHENTICATED };

  let sessionToken: string;
  try {
    const decoded = decodeURIComponent(cookieValue);
    sessionToken = decoded.split('.')[0] ?? '';
  } catch {
    sessionToken = cookieValue.split('.')[0] ?? '';
  }
  if (sessionToken.length === 0) return { ok: false, failure: UNAUTHENTICATED };

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
    return { ok: false, failure: UNAUTHENTICATED };
  }

  const jwt = await issueJwt({
    sub: session.user.id,
    role: session.user.role,
    organizationId: session.user.organizationId,
    email: session.user.email,
  });
  return { ok: true, jwt };
}

/** GET a JSON endpoint on NestJS with the session JWT, classifying failures. */
async function backendGet<T>(path: string): Promise<TenantResult<T>> {
  const auth = await backendJwt();
  if (!auth.ok) return { ok: false, failure: auth.failure };

  const target = new URL(path, env.BACKEND_API_URL);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.jwt}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TENANT_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    // Connection refused, DNS failure, or the timeout above. NEVER a 404: an
    // outage (or a hung backend) must not tell a user their workspace
    // disappeared.
    return { ok: false, failure: classifyBackendFailure(null, null) };
  }

  if (!upstream.ok) {
    // Read the body best-effort: 403 PASSWORD_CHANGE_REQUIRED is signalled in
    // the payload, and a non-JSON body must not throw here.
    const body: unknown = await upstream.json().catch(() => null);
    return { ok: false, failure: classifyBackendFailure(upstream.status, body) };
  }

  try {
    return { ok: true, data: (await upstream.json()) as T };
  } catch {
    // A 2xx with an unparseable body is a contract violation, not a missing
    // tenant - surface it as an error the user can retry.
    return { ok: false, failure: classifyBackendFailure(upstream.status, null) };
  }
}

/**
 * Resolve an organization by slug (the `[orgSlug]` URL segment). Cached per
 * request so a layout and any generateMetadata share one lookup.
 */
export const getOrganizationBySlug = cache(async function getOrganizationBySlug(
  slug: string,
): Promise<TenantResult<OrgLookup>> {
  return backendGet<OrgLookup>(`/api/organizations/by-slug/${encodeURIComponent(slug)}`);
});

/**
 * Resolve a project by slug within the actor's org (the `[projectSlug]`
 * segment, under `/organizations/projects/by-slug/`). Cached per request so
 * the project layout and its generateMetadata share one lookup.
 */
export const getProjectBySlug = cache(async function getProjectBySlug(
  slug: string,
): Promise<TenantResult<ProjectLookup>> {
  return backendGet<ProjectLookup>(`/api/projects/by-slug/${encodeURIComponent(slug)}`);
});
