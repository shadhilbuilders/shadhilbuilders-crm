// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Auth module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by NestJS AuthController (login, signup) and the Next.js BFF at
// apps/web/app/api/auth/[...all]/route.ts. Zod schemas validate before
// better-auth / Prisma are touched.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { RoleSchema } from './enums';

/**
 * Email format - strict enough to reject obvious typos, lenient enough to
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
 * breach-list checks (Have I Been Pwned) - Zod only enforces length here.
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
 * POST /api/auth/login - credentials for email+password sign-in.
 */
export const LoginDtoSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;

/**
 * POST /api/auth/signup - admin-provisioned account creation. `role`
 * defaults to TELECALLER for self-serve flows; managers/admins are created
 * from the admin console, which sets role explicitly.
 */
export const SignupDtoSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  role: RoleSchema.default('TELECALLER'),
  // Team ids are cuid2 - validate strictly (validation of existence happens
  // in the service).
  teamId: z.cuid2().optional(),
});
export type SignupDto = z.infer<typeof SignupDtoSchema>;

/**
 * POST /api/users - user creation via the role hierarchy
 * (DECISION-CHANGELOG Round 17): ADMIN → any role; MANAGER →
 * TELECALLER/SALES_EXEC in their own team; staff roles → nobody.
 * admin creating a manager without teamId auto-creates the team.
 */
export const CreateUserDtoSchema = SignupDtoSchema.extend({
  role: RoleSchema, // explicit - no default on the admin/manager surface
});
export type CreateUserDto = z.infer<typeof CreateUserDtoSchema>;

/**
 * Query filter for GET /api/users - the Users admin page. `role` accepts an
 * array so the UI can filter "show me SALES_EXEC + TELECALLER". The server
 * applies it as a WHERE role IN (...) inside the existing role-scoped query.
 * `limit`/`offset` drive server-side pagination (T-SRVPG, mirrors leads).
 */
export const UserFilterDtoSchema = z.object({
  role: z
    .union([RoleSchema, z.array(RoleSchema)])
    .optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type UserFilterDto = z.infer<typeof UserFilterDtoSchema>;

/** Paginated response for GET /api/users (mirrors LeadListResult). */
export const UserListResultSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      role: RoleSchema,
      teamId: z.string().nullable(),
      // Project names the user is a member of (via ProjectMember), for the
      // admin Users table (autoplan 2026-09-12). Empty array = no projects.
      projects: z.array(z.string()),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type UserListResult = z.infer<typeof UserListResultSchema>;

/**
 * PATCH /api/users/:id/role - role change (Round 20, rename 21). OWNER
 * can change anyone into anything (except into/out of OWNER); ADMIN can
 * change MANAGER/TELECALLER/SALES_EXEC into MANAGER/TELECALLER/SALES_EXEC;
 * MANAGER the same within their team. Guards: no self-changes,
 * demoting a team-leading manager is blocked, OWNER unassignable.
 */
export const ChangeRoleDtoSchema = z.object({
  role: RoleSchema,
});
export type ChangeRoleDto = z.infer<typeof ChangeRoleDtoSchema>;

/**
 * PATCH /api/users/:id - edit a user's name/email (autoplan 2026-09-09).
 * Hierarchy-gated in the service: the actor must strictly outrank the
 * target (no self-edit, OWNER protected). `name`/`email` are optional so a
 * caller can update just one field.
 */
export const UpdateUserDtoSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserDtoSchema>;

/**
 * Verified JWT claims. Populated by NestJS after `jose.jwtVerify` on the
 * incoming Authorization header. Never accepted as request input - this is
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
  sub: z.string().cuid2(),
  role: RoleSchema,
  teamId: z.string().cuid2().nullable().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/**
 * Refresh-token request body - sent when the access token expires. The
 * better-auth HTTP-only cookie carries the session token; this body is only
 * needed for mobile (Expo SecureStore) clients.
 */
export const RefreshTokenDtoSchema = z.object({
  refreshToken: z.string().min(20),
});
export type RefreshTokenDto = z.infer<typeof RefreshTokenDtoSchema>;

/**
 * T-S hardening (2026-09-04, Week 5): POST /api/users/:id/change-password.
 *
 * Change a user's own password (or, for ADMIN/OWNER, any user's).
 * The actor must be the target user themselves, OR have an ADMIN/OWNER
 * role (mirrors the existing role gates in users.service.ts). The old
 * password is validated against the user's credential Account row
 * (better-auth's scrypt hash); on success, the new password is hashed
 * with the same scrypt params and the Account row is updated. User.
 * mustChangePassword flips to false so JwtAuthGuard stops returning
 * PASSWORD_CHANGE_REQUIRED.
 *
 * Both `oldPassword` and `newPassword` are required and must be ≥ 8
 * chars (matches the seed's CreateUserDto shape).
 */
export const ChangePasswordDtoSchema = z.object({
  oldPassword: z
    .string()
    .min(1, 'Current password is required')
    .max(200, 'Password is too long'),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters')
    .max(200, 'Password is too long'),
});
export type ChangePasswordDto = z.infer<typeof ChangePasswordDtoSchema>;

/**
 * Client-side form contract for the /change-password page (T-S page +
 * zod validation, 2026-09-05). Extends the server's
 * ChangePasswordDtoSchema (wire contract, users.controller.ts) with
 * the `confirmPassword` field - a pure client concern, deliberately
 * NOT part of the wire DTO. The cross-field "passwords match" rule
 * lives in `.refine` so the error attaches to `confirmPassword` and
 * renders under the confirm input via the library Form's FieldError.
 *
 * Import zodResolver against THIS schema so client validation and
 * server validation can't drift: both fail on the same rules.
 */
export const ChangePasswordFormSchema = ChangePasswordDtoSchema.extend({
  confirmPassword: z.string().min(1, 'Please confirm the new password'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'New password and confirmation do not match',
  path: ['confirmPassword'],
});
export type ChangePasswordFormValues = z.infer<typeof ChangePasswordFormSchema>;