// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Auth module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by NestJS AuthController (login, signup) and the Next.js BFF at
// apps/web/app/api/auth/[...all]/route.ts. Zod schemas validate before
// better-auth / Prisma are touched.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { PhoneSchema } from './common';
import { RoleSchema } from './enums';
import { TeamReportingLineSchema } from './reporting';

/**
 * A phone field that can be SET, CLEARED, or OMITTED (2026-11-18).
 *
 * `PhoneSchema` alone is not enough for an edit surface. It rejects `''` (so
 * a blank form field fails with a readable message rather than writing an
 * empty string) and it rejects `null` (so there is NO way to erase a number
 * once set). A PII field with no erase path is not acceptable - and a plain
 * `.optional()` only covers "omitted", not "cleared".
 *
 * Verified against the installed Zod (the union wraps a `superRefine` +
 * `transform`, so this was checked rather than assumed):
 *   '9876543210' -> '919876543210'   (normalized)
 *   null         -> null             (clears the column)
 *   undefined    -> undefined        (field omitted, column untouched)
 *   ''           -> rejected         (never a silent no-op)
 */
export const ClearablePhoneSchema = z.union([PhoneSchema, z.null()]);
export type ClearablePhone = z.infer<typeof ClearablePhoneSchema>;

/**
 * Email format - strict enough to reject obvious typos, lenient enough to
 * accept every RFC-5322-legal address. We lowercase before persisting.
 *
 * `.min(3)` carries its own message: without one, an empty field surfaced
 * Zod's default "Too small: expected string to have >=3 characters", which
 * tells an operator nothing about which field or what to do.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Email is required')
  .max(254, 'Email must be at most 254 characters')
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
 * Team the new user joins (required by the SERVICE for staff roles, optional
 * in the DTO so the MANAGER auto-team path keeps working).
 *
 * NOT a `cuid2()` check. `Team.id` is Prisma's `@default(cuid())`; the seed
 * inserts cuid2 ids; and the team test fixtures/DB also hold slug-style ids
 * with dashes (`test-outbound-cron-team`, `auto-team-cap-<ts>`) - all of
 * them legitimately appear in the create dialog's Team picker. `z.cuid2()`
 * accepted the first two but REJECTED the dashed ones with a bare
 * "Invalid cuid2" that named no field and sent no request, so creating an
 * ENGINEER (the role that surfaces the Team picker) looked like a dead
 * button (reported 2026-11-01). This accepts the same shape `Project.id` /
 * `Phase.id` already use (see visits.ts / inventory.ts): a non-empty id
 * string. Existence, soft-deletion and org membership are enforced in the
 * service.
 */
const teamIdSchema = z.string().trim().min(1, 'Select a team for this user').optional();

/**
 * POST /api/auth/signup - admin-provisioned account creation. `role`
 * defaults to TELECALLER for self-serve flows; managers/admins are created
 * from the admin console, which sets role explicitly.
 *
 * `phone` (2026-11-18): staff contactability. Optional - an account is valid
 * without one, and FreJun provisioning is what actually requires a number.
 * Rejected for CUSTOMER below, because a buyer's number belongs to their
 * Lead (the WhatsApp identity key), not to a second copy on the account.
 */
export const SignupDtoSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  role: RoleSchema.default('TELECALLER'),
  teamId: teamIdSchema,
  phone: ClearablePhoneSchema.optional(),
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
  // Issue #8 slice 2: the Lead a CUSTOMER login belongs to. The service
  // requires it for CUSTOMER and rejects it for every other role; shape is
  // checked here, existence + same-org in UsersService.create.
  customerLeadId: z.string().min(1).max(64).optional(),
});
export type CreateUserDto = z.infer<typeof CreateUserDtoSchema>;

/**
 * Query filter for GET /api/users - the Users admin page. `role` accepts an
 * array so the UI can filter "show me SALES_EXEC + TELECALLER". The server
 * applies it as a WHERE role IN (...) inside the existing role-scoped query.
 * `limit`/`offset` drive server-side pagination (T-SRVPG, mirrors leads).
 */
export const UserFilterDtoSchema = z.object({
  role: z.union([RoleSchema, z.array(RoleSchema)]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  /**
   * T-USER-PROJECT-SCOPE (2026-09-16): narrow the result to staffed on ONE
   * project. Applied as an INTERSECTION with the caller's existing scope, so it
   * can only ever reduce the list - never grant a manager or telecaller anyone
   * they could not already see. Powers the lead "Assign to" / "Co-owner"
   * pickers, which previously offered staff from other projects (and, for an
   * admin/owner, other ORGANISATIONS).
   */
  projectId: z.string().min(1).optional(),
  /**
   * When true, exclude banned (deactivated) users so assignee pickers only
   * offer people who can actually take work. Off by default: the admin Users
   * table must still list banned users.
   */
  availableOnly: z.boolean().optional(),
  /**
   * When true, each row also carries `phone` (2026-11-18).
   *
   * OFF BY DEFAULT ON PURPOSE. This payload is not just the admin users table:
   * `useUsers` backs six other consumers - LeadReassignDialog,
   * LeadCoOwnerDialog, AddTeamMembersDialog, the team manager picker,
   * AssignedEngineerRow and the new-lead assignee picker. Returning staff
   * mobiles to all of them would widen PII exposure for no product reason, so
   * the field is opt-in and a future picker that forgets it leaks nothing.
   */
  includePhone: z.boolean().optional(),
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
      /**
       * Present only when the caller passed `includePhone` (2026-11-18).
       * Normalized digits-only, same shape as `Lead.phoneE164`. For a CUSTOMER
       * row this is DERIVED from their lead - a buyer has no `User.phone`
       * column value, so the same field carries the lead's number and
       * `phoneSource` says where it came from.
       */
      phone: z.string().nullable().optional(),
      /** How `phone` was resolved: the account column, or the lead. Omitted
       *  when `includePhone` was not set. */
      phoneSource: z.enum(['USER', 'LEAD']).optional(),
      // Project names derived from the user's team via ProjectTeam.
      // admin Users table (autoplan 2026-09-12). Empty array = no projects.
      projects: z.array(z.string()),
      // "Reports to" for the Users table (2026-10-08), now a LIST (2026-11-07).
      // Staff on several teams report to several managers and their RLS access
      // covers all those teams, so the single-object form was lossy. Every team
      // the user belongs to appears here, newest first, with that team's
      // manager (null when the team is unled). MANAGER/ADMIN still resolve to
      // the single org OWNER; OWNER/CUSTOMER get an empty array.
      reportsTo: z.array(TeamReportingLineSchema),
      /** @deprecated Use `reportsTo`. First entry's manager, kept for one
       *  release so an older client keeps rendering. Remove once no client
       *  reads it. */
      reportsToPrimary: z
        .object({ id: z.string(), name: z.string(), email: z.string() })
        .nullable()
        .optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type UserListResult = z.infer<typeof UserListResultSchema>;

/**
 * GET /api/users/:id - the user detail page (users/[userId], autoplan
 * 2026-09-13). `manager` ("Reports to") depends on the target's role - the
 * rule is the exhaustive map in ./reporting:
 *   - TELECALLER/SALES_EXEC/ENGINEER: their team's manager - assignable,
 *     null when unassigned/unmanaged. ENGINEER included 2026-11-07.
 *   - MANAGER/ADMIN: the org OWNER - fixed, never assignable.
 *   - OWNER/CUSTOMER: null (reports to nobody).
 * `projects` are the projects linked to the target's team via ProjectTeam.
 */
export const UserDetailSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  /**
   * Staff contact number, normalized digits-only (2026-11-18). Null when unset.
   *
   * For a CUSTOMER target this is DERIVED from their lead and is null when no
   * lead is linked - the account itself never stores a phone, because a buyer's
   * number is the lead's WhatsApp identity. `phoneSource` distinguishes the two
   * so the UI can label a derived value honestly.
   */
  phone: z.string().nullable().optional(),
  /** 'USER' = the account column; 'LEAD' = derived from customerLeadId. */
  phoneSource: z.enum(['USER', 'LEAD']).optional(),
  /** The "display team" (see resolveDisplayTeamId): newest membership for
   *  ordinary staff, the led team for a MANAGER. Null when none. */
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  /** EVERY team the user belongs to (TeamMember rows), newest first.
   *  Added 2026-11-07 so the "assign manager" picker can exclude teams the
   *  user is already on - `teamId` alone only excludes the display team, so an
   *  engineer on two teams could "assign" to a team they already belonged to
   *  and get a success toast for a no-op. */
  teamIds: z.array(z.string()).optional(),
  manager: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    })
    .nullable(),
  /**
   * Every team this user belongs to and its manager (2026-11-07). The list form
   * of `manager`: a two-team engineer reports to two managers, and collapsing
   * to one hid a real line. Empty for roles with no team membership.
   */
  reportsTo: z.array(TeamReportingLineSchema).optional(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});
export type UserDetail = z.infer<typeof UserDetailSchema>;

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
 * PATCH /api/users/:id - edit a user name/email/phone (autoplan 2026-09-09;
 * phone 2026-11-18). Hierarchy-gated in the service: the actor must strictly
 * outrank the target (no self-edit, OWNER protected). Fields are optional so a
 * caller can update just one.
 *
 * `phone: null` CLEARS the number (see ClearablePhoneSchema); omitting it
 * leaves the column untouched.
 */
export const UpdateUserDtoSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  phone: ClearablePhoneSchema.optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserDtoSchema>;

/**
 * PATCH /api/users/me - SELF-service profile edit (settings page, 2026-09-18).
 *
 * Separate from UpdateUserDtoSchema on purpose:
 *
 *   - `PATCH /api/users/:id` is an ADMIN action (hierarchy-gated, and it
 *     explicitly REFUSES self-edits - see users.service.assertOutranks call
 *     site: "self-profile editing is a separate surface"). This DTO is that
 *     separate surface: the route resolves the target from the JWT `sub`, so a
 *     caller can only ever edit themselves and no hierarchy check applies.
 *
 *   - `name` and `phone` only (phone added 2026-11-18). `email` is deliberately
 *     absent: this deployment configures NO email verification
 *     (packages/auth-client/src/auth.ts has no `emailVerification` block), so
 *     letting a user rewrite their own login address would move the account to
 *     an address nobody has proven they own. Email changes stay with
 *     ADMIN/OWNER via PATCH /api/users/:id.
 *
 *   - BOTH fields are optional. Before 2026-11-18 `name` was required, which was
 *     fine while it was the only field: now a staff member saving ONLY a phone
 *     number would otherwise have to resend their name. An empty body is
 *     rejected by the refinement below rather than being a silent no-op.
 *
 *   - `phone` is refused for CUSTOMER accounts in the service, not here: the
 *     DTO has no role to inspect. A buyer's number lives on their Lead.
 *
 * Reuses `nameSchema` so the self-edit rule (trim, 1..120) can never drift
 * from the admin edit rule.
 */
export const UpdateProfileDtoSchema = z
  .object({
    name: nameSchema.optional(),
    phone: ClearablePhoneSchema.optional(),
  })
  .refine((values) => values.name !== undefined || values.phone !== undefined, {
    message: 'Nothing to update - provide a name or a phone number',
  });
export type UpdateProfileDto = z.infer<typeof UpdateProfileDtoSchema>;

/**
 * PATCH /api/users/:id/manager - assign/reassign the reporting line for a
 * TELECALLER / SALES_EXEC / ENGINEER (autoplan 2026-09-13; ENGINEER
 * 2026-11-07). A user's "manager" is derived from `Team.managerId` via their
 * TeamMember row(s), so this DTO names the team to link them to. The team must
 * have a manager for the UI's concept of "manager" to mean anything, and the
 * server rejects an unled team with a clear message rather than silently
 * no-oping.
 *
 * Write mode depends on the TARGET's role:
 *   - TELECALLER / SALES_EXEC: MOVE - other memberships in the org are removed.
 *   - ENGINEER: ADDITIVE - existing memberships are kept (team membership is
 *     the engineer's project-access grant, so a move would revoke access).
 *     ADMIN/OWNER actors only.
 */
export const AssignManagerDtoSchema = z.object({
  teamId: z.string().cuid2(),
});
export type AssignManagerDto = z.infer<typeof AssignManagerDtoSchema>;

/**
 * Verified JWT claims. Populated by NestJS after `jose.jwtVerify` on the
 * incoming Authorization header. Never accepted as request input - this is
 * output-only, used by NestJS request-scoped middleware to seed Postgres
 * session vars (`app.user_id`, `app.current_user_role`) for RLS.
 *
 * Contract (symmetric with better-auth JWT bridge, HS256 v1):
 *   sub:    userId (cuid)
 *   role:   Role enum value
 *   iat:    issued-at (epoch seconds)
 *   exp:    expires-at (epoch seconds)
 *
 * Team membership is a TeamMember row, not a JWT claim
 * (T-TEAM-AUTHORITATIVE 2026-09-13).
 */
export const JwtPayloadSchema = z.object({
  sub: z.string().cuid2(),
  role: RoleSchema,
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
 * The `code` JwtAuthGuard puts on its 403 while a user still owes a password
 * rotation (see apps/backend/src/auth/jwt-auth.guard.ts).
 *
 * Declared here - in the shared wire-contract package - because THREE layers
 * read it and none of them can import the others: the browser client
 * (apis/client.ts) routes the 403 to the right rotation screen, the server
 * tenant guard routes it to /change-password, and a test asserts the
 * backend's own literal matches. A hand-copied string is what let the
 * cookie-name bug ship four times (see lib/session-cookie.ts); the same
 * failure mode was already present for this code, so it gets one home.
 */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

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
  // Required for self-service rotation (enforced in UsersService); omitted
  // when an ADMIN/OWNER resets ANOTHER user's password.
  oldPassword: z
    .string()
    .min(1, 'Current password is required')
    .max(200, 'Password is too long')
    .optional(),
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
  oldPassword: z.string().min(1, 'Current password is required').max(200, 'Password is too long'),
  confirmPassword: z.string().min(1, 'Please confirm the new password'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'New password and confirmation do not match',
  path: ['confirmPassword'],
});
export type ChangePasswordFormValues = z.infer<typeof ChangePasswordFormSchema>;
/**
 * Admin/owner password-reset form (users table + user detail page). No
 * current password - the actor is resetting someone else's.
 */
export const AdminResetPasswordFormSchema = z
  .object({
    newPassword: ChangePasswordDtoSchema.shape.newPassword,
    confirmPassword: z.string().min(1, 'Please confirm the new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'New password and confirmation do not match',
    path: ['confirmPassword'],
  });
export type AdminResetPasswordFormValues = z.infer<typeof AdminResetPasswordFormSchema>;
