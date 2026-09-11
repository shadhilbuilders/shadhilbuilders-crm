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
import 'server-only';

import { cookies } from 'next/headers';
import { issueJwt } from '@shadhil/auth';
import { prisma } from '@shadhil/database';

import { env } from '@/lib/env';

const SESSION_COOKIE = 'better-auth.session_token';

/** Shape of GET /organizations/by-slug/:slug. */
export type OrgLookup = { id: string; name: string; slug: string };
/** Shape of GET /organizations/projects/by-slug/:slug. */
export type ProjectLookup = { id: string; slug: string; name: string };

class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * Mint a backend JWT for the current request's session. Throws when the
 * session cookie is missing/expired so layouts can redirect/notFound instead
 * of rendering a half-authed page.
 */
async function backendJwt(): Promise<string> {
  const cookieStore = await cookies();
  const cookieValue =
    cookieStore.get(SESSION_COOKIE)?.value ??
    cookieStore
      .getAll()
      .find((c) => c.name.startsWith(SESSION_COOKIE))?.value ??
    null;
  if (cookieValue === null) throw new NotAuthenticatedError();

  let sessionToken: string | null;
  try {
    const decoded = decodeURIComponent(cookieValue);
    sessionToken = decoded.split('.')[0] ?? null;
  } catch {
    sessionToken = cookieValue.split('.')[0] ?? null;
  }
  if (sessionToken === null || sessionToken.length === 0) {
    throw new NotAuthenticatedError();
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
    throw new NotAuthenticatedError();
  }

  return issueJwt({
    sub: session.user.id,
    role: session.user.role,
    teamId: session.user.teamId,
    organizationId: session.user.organizationId,
    email: session.user.email,
  });
}

/** GET a JSON endpoint on NestJS with the session JWT; null on 404. */
async function backendGet<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const jwt = await backendJwt();
  const target = new URL(path, env.BACKEND_API_URL);
  const upstream = await fetch(target, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
    cache: 'no-store',
  });
  if (!upstream.ok) return { ok: false, status: upstream.status };
  return { ok: true, data: (await upstream.json()) as T };
}

/**
 * Resolve an organization by slug (the `[orgSlug]` URL segment). Returns
 * null when unauthenticated or the org is not visible to the caller.
 */
export async function getOrganizationBySlug(
  slug: string,
): Promise<OrgLookup | null> {
  try {
    const res = await backendGet<OrgLookup>(
      `/api/organizations/by-slug/${encodeURIComponent(slug)}`,
    );
    return res.ok ? res.data : null;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return null;
    throw err;
  }
}

/**
 * Resolve a project by slug within the actor's org (the `[projectSlug]`
 * segment, under `/organizations/projects/by-slug/`). Returns null when
 * unauthenticated or the project is not visible.
 */
export async function getProjectBySlug(
  slug: string,
): Promise<ProjectLookup | null> {
  try {
    const res = await backendGet<ProjectLookup>(
      `/api/projects/by-slug/${encodeURIComponent(slug)}`,
    );
    return res.ok ? res.data : null;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return null;
    throw err;
  }
}
