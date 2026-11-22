// ────────────────────────────────────────────────────────────────────────────
// Staff invites - wire contract (2026-11-20).
// ────────────────────────────────────────────────────────────────────────────
// A single-use link a staff member completes themselves, ADDITIVE to the
// admin's existing temp-password create path (`CreateUserDtoSchema` in
// ./auth.ts, which is unchanged).
//
// The token is NEVER part of any row shape below. The raw value leaves the
// server exactly once, in `CreateInviteResult.inviteUrl` / `.whatsappUrl` /
// `.messageText`, and only its sha256 is stored.
//
// Endpoints:
//   POST   /api/invites                        -> CreateInviteResult
//   GET    /api/invites?status=&limit=&offset= -> InviteListResult
//   POST   /api/invites/:id/resend             -> CreateInviteResult
//   POST   /api/invites/:id/revoke             -> InviteRow (status REVOKED)
//   GET    /api/public/invites/:token          -> PublicInvitePreview
//   POST   /api/public/invites/:token/accept   -> AcceptInviteResult
import { z } from 'zod';

import { ClearablePhoneSchema, EmailSchema } from './auth';
import { CountryCodeSchema, PhoneSchema } from './common';
import { RoleSchema } from './enums';

/**
 * Invite lifecycle as the CLIENT sees it.
 *
 * EXPIRED is derived, never stored: a PENDING row past `expiresAt` reads as
 * EXPIRED. That is why the list filter cannot be a plain `WHERE status = ?`
 * on the column - see InviteFilterDtoSchema's note.
 */
export const InviteStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;

/**
 * Stable machine-readable error codes, shared by all three layers that read
 * them: the NestJS service (throws), the accept page (routes to a terminal
 * card), and the admin table's toast mapper. One home per string, for the
 * same reason PASSWORD_CHANGE_REQUIRED lives in ./auth.ts - a hand-copied
 * literal is how the cookie-name bug shipped four times.
 */
export const INVITE_INVALID = 'INVITE_INVALID';
export const INVITE_EXPIRED = 'INVITE_EXPIRED';
export const INVITE_REVOKED = 'INVITE_REVOKED';
export const INVITE_ALREADY_ACCEPTED = 'INVITE_ALREADY_ACCEPTED';
export const INVITE_ALREADY_PENDING = 'INVITE_ALREADY_PENDING';
export const INVITE_EMAIL_TAKEN = 'INVITE_EMAIL_TAKEN';
/** Reuses the create-user code so both forms render the same message. */
export const EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS';

/**
 * How long a link stays valid. Exported so the backend, the UI's "expires in
 * 7 days" copy, and the tests cannot disagree.
 */
export const INVITE_TTL_DAYS = 7;

/**
 * POST /api/invites - create an invite.
 *
 * `phone` is REQUIRED here, unlike CreateUserDtoSchema where it is optional.
 * It is the number the link is SENT to, and it is what the `wa.me` deep link
 * addresses, so an invite without one has no one-tap delivery path. Validated
 * by the transforming `PhoneSchema`, so the stored value and the
 * `wa.me` path both get the normalized digits-only form.
 *
 * `teamId` is required by the SERVICE (not here) for TELECALLER / SALES_EXEC /
 * ENGINEER - the same split `CreateUserDtoSchema` uses, so the MANAGER
 * auto-team path keeps working and the service can throw a precise message.
 *
 * CUSTOMER is intentionally absent from the creatable roles: a buyer login
 * needs a `customerLeadId` that only `POST /api/users` collects. The service
 * rejects it with a readable message rather than the DTO silently allowing it.
 */
export const CreateInviteDtoSchema = z.object({
  /**
   * OPTIONAL since 2026-11-21. Field staff are often reachable on WhatsApp and
   * nowhere else, and the login path now accepts a phone, so an invite can go
   * out without an address. The service substitutes a generated
   * `noemail+<hex>@users.invalid` placeholder because `User.email` is NOT NULL
   * and sign-in looks users up by email; see `isPlaceholderEmail`.
   */
  email: EmailSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must be at most 120 characters'),
  phone: PhoneSchema,
  phoneCountry: CountryCodeSchema.optional(),
  role: RoleSchema,
  teamId: z.string().trim().min(1).max(64).optional(),
});
export type CreateInviteDto = z.infer<typeof CreateInviteDtoSchema>;

/**
 * GET /api/invites filters.
 *
 * STATUS IS NOT A COLUMN FILTER. EXPIRED is computed from
 * `(status, expiresAt)`, but a row `create()` replaced can also be STORED as
 * EXPIRED, so the service must translate:
 *   EXPIRED -> (status = 'EXPIRED') OR (status = 'PENDING' AND expiresAt <= now())
 *   PENDING -> status = 'PENDING' AND expiresAt >  now()
 *   others  -> status = <value>
 * Applying this in memory instead would silently narrow only the loaded page
 * and make the pagination total lie - the same defect T-SRVPG fixed for the
 * Members table.
 *
 * `status` accepts a comma-joined string too (the web MultiSelect sends
 * `?status=PENDING,EXPIRED`), mirroring UserFilterDtoSchema.role.
 */
export const InviteFilterDtoSchema = z.object({
  status: z
    .union([InviteStatusSchema, z.array(InviteStatusSchema), z.string()])
    .optional()
    .transform((value): InviteStatus[] | undefined => {
      if (value === undefined) return undefined;
      const raw = typeof value === 'string' ? value.split(',') : value;
      const list = (Array.isArray(raw) ? raw : [raw])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length === 0) return undefined;
      // Unknown values are DROPPED rather than 400'd: a stale bookmark or a
      // hand-typed query should narrow the list, not break the page. An
      // entirely unknown filter falls back to "no filter", which shows
      // everything - the safe direction for an admin list.
      const valid = list.filter((s): s is InviteStatus =>
        (InviteStatusSchema.options as readonly string[]).includes(s),
      );
      return valid.length > 0 ? valid : undefined;
    })
    // `.optional()` on the TRANSFORMED side, not just the input: without this
    // zod infers `status: InviteStatus[] | undefined` as a REQUIRED key, so
    // every `{limit, offset}` literal fails to type-check against the DTO.
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type InviteFilterDto = z.infer<typeof InviteFilterDtoSchema>;

/** The team an invite targets, as a row renders it. */
export const InviteTeamRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type InviteTeamRef = z.infer<typeof InviteTeamRefSchema>;

/**
 * One invite as the admin surfaces render it.
 *
 * `phone` is always present (required on create) so the table can offer
 * WhatsApp / Call without a second fetch. `invitedBy` is the actor, for the
 * "who invited this person" column and the audit trail.
 */
export const InviteRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  /** Normalized digits-only E.164 (`91XXXXXXXXXX`). */
  phone: z.string(),
  role: RoleSchema,
  team: InviteTeamRefSchema.nullable(),
  /** Derived: a PENDING row past expiresAt reports EXPIRED. */
  status: InviteStatusSchema,
  /** ISO 8601. The absolute deadline, not a countdown. */
  expiresAt: z.string(),
  invitedBy: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InviteRow = z.infer<typeof InviteRowSchema>;

export const InviteListResultSchema = z.object({
  rows: z.array(InviteRowSchema),
  total: z.number().int().nonnegative(),
});
export type InviteListResult = z.infer<typeof InviteListResultSchema>;

/**
 * Response to create AND resend. Identical shape on purpose: the "link shown
 * once" panel is the same component in both flows.
 *
 * `inviteUrl` is the ONLY time the raw token leaves the server. `whatsappUrl`
 * and `messageText` are derived server-side so the client never assembles a
 * `wa.me` URL - it requires the digits-only form, and a stray `+` silently
 * 404s, so one tested implementation beats two hand-rolled strings.
 */
export const CreateInviteResultSchema = z.object({
  invite: InviteRowSchema,
  /** Absolute URL the staff member opens: `<appUrl>/invite/<rawToken>`. */
  inviteUrl: z.string(),
  /** `https://wa.me/<digits>?text=<encoded messageText>` - consumer WhatsApp. */
  whatsappUrl: z.string(),
  /** The prefilled message, so the UI can show/preview or let the admin copy it. */
  messageText: z.string(),
});
export type CreateInviteResult = z.infer<typeof CreateInviteResultSchema>;

/**
 * GET /api/public/invites/:token - the unauthenticated preview the accept
 * page renders. Deliberately narrow: no user ids, no inviter email, no token
 * echo. `email` and `phone` ARE included - they are what the invitee is
 * signing up with, and both already travelled in the message they received.
 */
export const PublicInvitePreviewSchema = z.object({
  organizationName: z.string(),
  organizationSlug: z.string(),
  /** The pinned login address. Presentational - the accept form has no email field. */
  email: z.string(),
  /** Prefilled in the accept form; the invitee may correct a typo. */
  phone: z.string(),
  name: z.string(),
  role: RoleSchema,
  teamName: z.string().nullable(),
  invitedByName: z.string(),
  expiresAt: z.string(),
  status: InviteStatusSchema,
});
export type PublicInvitePreview = z.infer<typeof PublicInvitePreviewSchema>;

/**
 * POST /api/public/invites/:token/accept.
 *
 * NO EMAIL FIELD: the address is pinned on the invite, so a forwarded link
 * cannot be claimed by a different person and there is nothing to mismatch.
 *
 * `phone` is OPTIONAL and means "correct it": omitted keeps the invite's
 * number, provided replaces it and the change is recorded in the audit row.
 * The asymmetry with email is deliberate - a wrong email means the invite
 * reached a stranger's inbox (pin hard); a wrong phone means it reached a
 * stranger's handset, but the person accepting is then the one fixing it,
 * which is self-limiting and leaves a trail. Pinning both would make a single
 * digit typo require a full re-invite.
 *
 * `ClearablePhoneSchema` (not bare `PhoneSchema`) so `null` and `undefined`
 * behave distinctly: null would CLEAR, undefined keeps. The service treats a
 * provided non-null value as a correction.
 */
export const AcceptInviteDtoSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must be at most 120 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  phone: ClearablePhoneSchema.optional(),
  /**
   * The country the corrected number was typed in (2026-11-22). Absent keeps
   * the pre-existing Indian reading, exactly like every other phone DTO.
   */
  phoneCountry: CountryCodeSchema.optional(),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteDtoSchema>;

/**
 * Success shape. The client signs in with `email` + the password it just set
 * (the tested better-auth path); `organizationSlug` lets it land on the right
 * tenant after the post-login redirect.
 */
export const AcceptInviteResultSchema = z.object({
  ok: z.literal(true),
  email: z.string(),
  organizationSlug: z.string(),
});
export type AcceptInviteResult = z.infer<typeof AcceptInviteResultSchema>;

/**
 * Client-side form contract for the accept page. Extends the wire DTO with
 * `confirmPassword` - a pure client concern, deliberately not on the wire -
 * so the two cannot drift on the rules that matter (name length, password
 * length). `phone` is a plain string so a controlled input can hold it; the
 * page maps `'' -> undefined` on submit (keep the invite's number).
 */
export const AcceptInviteFormSchema = AcceptInviteDtoSchema.extend({
  phone: z.string().optional(),
  confirmPassword: z.string().min(1, 'Please confirm your password'),
}).refine((values) => values.password === values.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});
export type AcceptInviteFormValues = z.infer<typeof AcceptInviteFormSchema>;
