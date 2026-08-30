// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM — Auth module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by NestJS AuthController (login, signup) and the Next.js BFF at
// apps/web/app/api/auth/[...all]/route.ts. Zod schemas validate before
// better-auth / Prisma are touched.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { RoleSchema } from './enums';

/**
 * Email format — strict enough to reject obvious typos, lenient enough to
 * accept every RFC-5322-legal address. We lowercase before persisting.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Invalid email address');

/**
 * Password rule: 8–128 chars. NIST 800-63B strength comes from server-side
 * breach-list checks (Have I Been Pwned) — Zod only enforces length here.
 */
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

/**
 * Display name for the user (full name). Trimmed; required.
 */
const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(120, 'Name must be at most 120 characters');

/**
 * POST /api/auth/login — credentials for email+password sign-in.
 */
export const LoginDtoSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;

/**
 * POST /api/auth/signup — admin-provisioned account creation. `role`
 * defaults to TELECALLER for self-serve flows; managers/admins are created
 * from the admin console, which sets role explicitly.
 */
export const SignupDtoSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  role: RoleSchema.default('TELECALLER'),
  teamId: z
    .string()
    .cuid('teamId must be a valid cuid')
    .optional(),
});
export type SignupDto = z.infer<typeof SignupDtoSchema>;

/**
 * Verified JWT claims. Populated by NestJS after `jose.jwtVerify` on the
 * incoming Authorization header. Never accepted as request input — this is
 * output-only, used by NestJS request-scoped middleware to seed Postgres
 * session vars (`app.user_id`, `app.current_user_role`) for RLS.
 *
 * Contract (symmetric with better-auth JWT bridge, HS256 v1):
 *   sub:    userId (cuid)
 *   role:   Role enum value
 *   teamId: optional team membership (nullable for admins / cross-team managers)
 *   iat:    issued-at (epoch seconds)
 *   exp:    expires-at (epoch seconds)
 */
export const JwtPayloadSchema = z.object({
  sub: z.string().cuid(),
  role: RoleSchema,
  teamId: z.string().cuid().nullable().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/**
 * Refresh-token request body — sent when the access token expires. The
 * better-auth HTTP-only cookie carries the session token; this body is only
 * needed for mobile (Expo SecureStore) clients.
 */
export const RefreshTokenDtoSchema = z.object({
  refreshToken: z.string().min(20),
});
export type RefreshTokenDto = z.infer<typeof RefreshTokenDtoSchema>;