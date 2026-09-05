// JWT verification helper used by NestJS JwtStrategy.
// Shares BETTER_AUTH_SECRET with better-auth's jwt() plugin (HS256, iss: shadhil-crm).
//
// Pattern (eng review A4): verify on every NestJS request, then SET LOCAL
// app.user_id / app.user_role / app.user_team_id in a transaction so RLS
// policies in Postgres can filter per request.
//
// SECOND-ROUND AUDIT (AR-2, 2026-08-31):
//   - Role values are EXACTLY the Prisma `Role` enum (UPPERCASE): ADMIN |
//     MANAGER | SALES_EXEC | TELECALLER. The policies compare
//     `current_setting('app.user_role') = 'ADMIN'` etc. - a lowercase or
//     differently-spelled value would filter every row for every non-admin.
//   - A token WITHOUT an explicit role claim is now REJECTED (was: silently
//     defaulted to 'telecaller', which let role-less tokens read/write any
//     telecaller-scoped row).

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Keep in lockstep with packages/database/prisma/schema.prisma enum Role.
// (Imported from @shadhil/api-types would create a package cycle; a local
// union mirror + a compile-time exhaustiveness check in api-types tests
// covers it. roles.ts is the single runtime source of truth.)
export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'SALES_EXEC',
  'TELECALLER',
] as const;
export type Role = (typeof ROLES)[number];

export type JwtPayload = {
  sub: string; // user id
  role: Role;
  teamId: string | null;
  email: string;
  iat: number;
  exp: number;
  iss: string;
};

const ISSUER = 'shadhil-crm';
const AUDIENCE = 'shadhil-crm';

function getSecret(): Uint8Array {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET missing or too short (need >= 32 chars)');
  }
  return new TextEncoder().encode(secret);
}

/** Validate a raw role claim against the Prisma Role enum (AR-2). */
function parseRole(raw: unknown): Role {
  if (typeof raw !== 'string') {
    throw new Error('JWT missing role claim');
  }
  const normalized = raw.trim().toUpperCase();
  if (!(ROLES as readonly string[]).includes(normalized)) {
    throw new Error(`JWT role "${raw}" is not a valid Role enum value`);
  }
  return normalized as Role;
}

/**
 * Verify a JWT issued by better-auth's jwt() plugin and return a typed payload.
 * Throws on invalid/expired tokens - caller maps to 401.
 * Also throws when the token lacks a role claim or carries a role that is not
 * exactly one of the Prisma enum values (no silent defaults - AR-2).
 */
export async function verifyJwt(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });

  if (typeof payload.sub !== 'string') {
    throw new Error('JWT missing sub claim');
  }

  // better-auth's jwt() plugin puts role/teamId in the `user` object.
  // Accept both flat (role at top level) and nested (user.role) shapes so
  // tokens issued by issueJwt and tokens issued by better-auth itself both
  // round-trip cleanly.
  const top = payload as Record<string, unknown>;
  const nested = (top.user as { role?: string; teamId?: string | null; email?: string } | undefined) ?? undefined;
  const roleRaw = (top.role as string | undefined) ?? nested?.role;
  const teamRaw = (top.teamId as string | null | undefined) ?? nested?.teamId ?? null;
  const emailRaw = (top.email as string | undefined) ?? nested?.email ?? '';

  return {
    sub: payload.sub,
    role: parseRole(roleRaw),
    teamId: teamRaw ?? null,
    email: emailRaw,
    iat: payload.iat ?? 0,
    exp: payload.exp ?? 0,
    iss: payload.iss ?? ISSUER,
  };
}

/**
 * Issue a JWT (used by tests and by better-auth's own jwt() plugin).
 * Production code should rely on better-auth's $Infer.Session and the
 * /api/auth/token endpoint, not call this directly.
 *
 * The role + teamId are stored under a `user` claim (matching better-auth's
 * jwt() plugin shape) so verifyJwt can read them out consistently.
 */
export async function issueJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss'>,
  expiresInSec = 60 * 60 * 24 * 7,
): Promise<string> {
  const { SignJWT } = await import('jose');
  const { sub, role, teamId, email } = payload;
  return await new SignJWT({
    role,
    teamId,
    email,
    user: { role, teamId, email },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSec}s`)
    .sign(getSecret());
}

// Re-exported for tests that need a no-op remote-jwks reference.
export const _remoteJWKSet = createRemoteJWKSet;