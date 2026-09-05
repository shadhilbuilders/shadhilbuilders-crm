// @shadhil/auth - barrel.
// Eng review C3: @shadhil/* scope (not bare "auth-client" or "auth").
//
// Provides:
//   - `auth` - better-auth server instance (used by Next.js catch-all + NestJS)
//   - `authClient` - better-auth React client (used by Next.js useSession, signIn, etc.)
//   - `verifyJwt` / `issueJwt` - JWT bridge to NestJS JwtStrategy
//   - `assertAuthEnv` - env validation (fails at module load if missing)
//   - `Auth` / `AuthSession` / `AuthUser` - inferred types
//
// Hard constraints (eng review 2026-08-30):
//   - A4: NO organization() plugin - Team is the single grouping
//   - JWT plugin with issuer 'shadhil-crm' is the bridge to NestJS

export { auth, type Auth } from './auth';
export { authClient, type AuthClient } from './auth-client';
export { verifyJwt, issueJwt, type JwtPayload } from './jwt';
export { assertAuthEnv, type AuthEnv } from './env';
export type { AuthSession, AuthUser } from './types';
