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
    admin(),
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
