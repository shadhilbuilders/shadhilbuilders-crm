import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // ── better-auth (eng review A4: no organization plugin) ──────────────
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >= 32 chars'),
    BETTER_AUTH_URL: z.url(),

    // ── Database (NestJS writes via PgBouncer; web reads User only) ──────
    DIRECT_DATABASE_URL: z.url(),

    // ── JWT (shared secret with NestJS JwtStrategy) ──────────────────────
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().default('shadhil-crm'),

    // ── NestJS BFF proxy target ──────────────────────────────────────────
    BACKEND_API_URL: z.url().default('http://localhost:8080'),

    // ── Error monitoring (Sentry - optional) ─────────────────────────────
    SENTRY_DSN: z.url().optional(),
    SENTRY_ORG: z.string().min(1).optional(),
    SENTRY_PROJECT: z.string().min(1).optional(),
    SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
  },

  client: {
    NEXT_PUBLIC_API_BASE_URL: z.url().default('http://localhost:8080'),
    NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Shadhil Builders CRM'),
    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    NEXT_PUBLIC_DEBUG_MODE: z
      .string()
      .transform((val) => val === 'true')
      .default(false),

    // ── 6 Inputs (§17) - placeholders work, real values via Coolify ──────
    NEXT_PUBLIC_RERA_NUMBER: z.string().min(1).default('TN/PENDING/RERA'),
    NEXT_PUBLIC_CMDA_NUMBER: z.string().min(1).default('CMDA/PENDING'),
    NEXT_PUBLIC_RERA_VALID_FROM: z.string().default('2026-01-01'),
    NEXT_PUBLIC_RERA_VALID_UNTIL: z.string().default('2027-12-31'),
    NEXT_PUBLIC_MODEL_C_ENABLED: z
      .string()
      .transform((val) => val === 'true')
      .default(true),
  },

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_ISSUER: process.env.JWT_ISSUER,
    BACKEND_API_URL: process.env.BACKEND_API_URL,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_DEBUG_MODE: process.env.NEXT_PUBLIC_DEBUG_MODE,
    NEXT_PUBLIC_RERA_NUMBER: process.env.NEXT_PUBLIC_RERA_NUMBER,
    NEXT_PUBLIC_CMDA_NUMBER: process.env.NEXT_PUBLIC_CMDA_NUMBER,
    NEXT_PUBLIC_RERA_VALID_FROM: process.env.NEXT_PUBLIC_RERA_VALID_FROM,
    NEXT_PUBLIC_RERA_VALID_UNTIL: process.env.NEXT_PUBLIC_RERA_VALID_UNTIL,
    NEXT_PUBLIC_MODEL_C_ENABLED: process.env.NEXT_PUBLIC_MODEL_C_ENABLED,
  },

  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',
});
