// better-auth server instance.
// Shared between apps/web (Next.js catch-all) and apps/backend (NestJS auth).
//
// Eng review constraints baked in:
//   - A4: NO organization() plugin — Team is the single grouping concept
//   - JWT plugin (HS256, issuer: 'shadhil-crm') is the bridge to NestJS JwtStrategy
//   - admin() plugin for role gating (admin role check)
//
// T-S (2026-09-03): placeholder-password lockdown. The seed script
// (packages/database/src/seed.ts) provisions owner@/admin@/manager@/
// telecaller@/sales_exec@shadhilbuilders.in with a documented
// placeholder password per Plan §17 Input #5. If a production DB
// ever runs the seed, those credentials are live until manually
// rotated. The gate itself lives in apps/backend/src/auth/
// placeholder-gate.middleware.ts as a Nest middleware (sitting in
// front of the better-auth catch-all in BetterAuthMiddlewareModule).
// The placeholder email list is in packages/auth-client/
// placeholder-users.json — committed, lists the 5 seed emails. The
// file is empty in production deploys that don't run the seed; the
// gate is a no-op.

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
// adminAc — better-auth's default admin permission statement set, reused as
// the definition for our ADMIN role key (Round 20).
import { adminAc } from 'better-auth/plugins/admin/access';

import { prisma } from '@shadhil/database';
import { assertAuthEnv } from './env';

const env = assertAuthEnv();

// `Auth` from better-auth has a deeply-parameterized inferred type that
// reaches into zod/better-auth internal paths. Treat as opaque from the
// consumer side; the runtime contract is what matters.
export const auth: any = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },

  // SECOND-ROUND AUDIT B4a (2026-08-31): the Prisma `User.role` column is a
  // NOT NULL Role enum with no default — better-auth's signUpEmail inserts a
  // bare user and Prisma rejects it ("Invalid value for argument `role`").
  // Declare role/teamId as additional fields with server-side defaults so
  // every better-auth-created user lands with a valid enum role and a team
  // slot to be filled by an admin (plan A6: single primary role).
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'TELECALLER',
        input: false, // AR-8: roles are set by admins/seed only, never via signup input
      },
      teamId: {
        type: 'string',
        required: false,
        defaultValue: null,
        input: false,
      },
    },
  },

  // Per better-auth-best-practices skill: jwt + admin only.
  // NO organization() — Team model is the single grouping.
  plugins: [
    jwt({
      jwt: {
        issuer: 'shadhil-crm',
        audience: 'shadhil-crm',
        expiresIn: '7d',
      },
    }),
    // AR-2/B4a: admin() plugin injects role: options.defaultRole ??
    // "user" on user.create. "user" is not a Prisma Role enum value ->
    // signUpEmail always failed. Set it.
    //
    // Role model (Round 20/21, 2026-08-31 → 2026-09-03): one OWNER
    // (seed + partial unique index only — the API can never create one)
    // bootstraps ADMINs; ADMIN creates MANAGER users; each MANAGER
    // creates TELECALLER/SALES_EXEC under their team.
    // roles: our Prisma Role keys mapped to better-auth statement sets —
    // ADMIN reuses the stock adminAc; OWNER (org owner, exactly one per
    // DB constraint) also gets adminAc. adminRoles then gates better-auth
    // admin endpoints to OWNER + ADMIN (case-insensitive match).
    admin({
      defaultRole: 'TELECALLER',
      roles: {
        ADMIN: adminAc,
        OWNER: adminAc,
      },
      adminRoles: ['OWNER', 'ADMIN'],
    }),
  ],

  trustedOrigins: [
    'http://localhost:3000', // Next.js web (dev)
    'http://localhost:8081', // Expo dev server
    'https://crm.shadhilbuilders.in',           // user-facing app
    'https://api.crm.shadhilbuilders.in',       // backend API
  ],

  // T-PERF-2 #1: cookie scope (plan Decision Audit #37).
  //
  // The default better-auth cookie scope is host-only — which is
  // exactly what we want. We must NOT enable `crossSubDomainCookies`
  // because that would set Domain: '.crm.shadhilbuilders.in' and
  // auto-send the session cookie to BOTH crm.shadhilbuilders.in
  // (the app) AND api.crm.shadhilbuilders.in (the API) per RFC 6265.
  //
  // If a future feature legitimately needs cross-subdomain cookies
  // (e.g., sharing session with admin.crm.shadhilbuilders.in), set
  // an EXPLICIT whitelist via `additionalCookies` so only the named
  // cookies cross, not the session token.
  //
  // Production deploys that need to override the default (e.g., to
  // share cookies with a *.shadhilbuilders.in marketing site) should
  // set BETTER_AUTH_ALLOW_CROSS_SUBDOMAIN_COOKIES=true, but the
  // default (and the recommendation for this deployment) is off.

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },
});

export type Auth = typeof auth;
