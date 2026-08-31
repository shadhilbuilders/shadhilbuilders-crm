// better-auth server instance.
// Shared between apps/web (Next.js catch-all) and apps/backend (NestJS auth).
//
// Eng review constraints baked in:
//   - A4: NO organization() plugin — Team is the single grouping concept
//   - JWT plugin (HS256, issuer: 'shadhil-crm') is the bridge to NestJS JwtStrategy
//   - admin() plugin for role gating (admin role check)

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';

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
    // AR-2/B4a: admin() plugin injects role: options.defaultRole ?? "user" on user.create.
    // "user" is not a Prisma Role enum value -> signUpEmail always failed. Set it.
    admin({ defaultRole: 'TELECALLER' }),
  ],

  trustedOrigins: [
    'http://localhost:3000', // Next.js web
    'http://localhost:8081', // Expo dev server
    'https://crm.shadhilbuilders.in',
    'https://crm-api.shadhilbuilders.in',
  ],

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },
});

export type Auth = typeof auth;
