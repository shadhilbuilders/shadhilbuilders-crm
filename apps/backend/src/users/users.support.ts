// Shared ground for the Users concerns (Round 67, 2026-11-26).
//
// WHY THIS FILE EXISTS: users.service.ts had grown to 2,658 lines and mixed six
// concerns - login lookup, create/role/update, self profile, manager lines,
// the directory reads, and the uniqueness-error mapping. The ceiling in
// .cursor/rules/common-coding-style.mdc is 800 lines.
//
// The split is by CONCERN, not by table: one file per question a caller has.
// What lives here is the part more than one concern needs.
//
// UsersBase supplies `client`, `logger`, `storage` and the four directory
// lookups. That is deliberate: every extracted method body is byte-identical to
// the line it replaced, so the move cannot have changed behaviour, and the
// existing 4,000 lines of tests still drive the same code. Subclasses are built
// with `new UsersWrites(deps)`, never injected, so the Nest module and the
// facade's constructor signature are untouched.

import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { normalizePhoneDigits, reportingTargetFor } from '@shadhil/api-types';
import type { TeamReportingLine } from '@shadhil/api-types';
import { CodedConflictException } from '../common/errors/coded-exception';
import { avatarUrlFor } from '../storage/media-display';
import { keyBelongsToOrg } from '../storage/media-key-scope';
import type { StorageProvider } from '../storage/storage.provider';
import { findOrgOwner } from './roles';

/**
 * T-EMAIL-PER-ORG (2026-10-04): `User.email` uniqueness is scoped to the
 * organization (`@@unique([email, organizationId])` - see schema.prisma),
 * so a P2002 here means "this email is already used by SOMEONE IN THIS
 * ORG", not a cross-org collision. Thrown as a 409 with a stable code so
 * the create/update forms can show a precise, actionable message instead
 * of the bare "Internal server error" a raw PrismaClientKnownRequestError
 * produced (reported 2026-10-04 - users.service.ts:192 POST /api/users).
 *
 * CONSTRAINT ATTRIBUTION (rewritten 2026-11-18, user-phone slice). The
 * original version assumed `(email, organizationId)` was the ONLY unique
 * constraint on `User` and mapped every P2002 to EMAIL_ALREADY_EXISTS. The
 * partial phone index added by this slice makes that assumption false: a
 * duplicate phone would have been reported to the user as a duplicate email,
 * pointing them at the wrong field.
 *
 * The constraint NAME lives at
 * `meta.driverAdapterError.cause.constraint.index` - verified against
 * @prisma/adapter-pg@7.10.0 (dist/index.mjs, SQLSTATE 23505 sets
 * `constraint = { index: error.constraint }`, so it is an OBJect with an
 * `index` key, not a string) and @prisma/client@7.10.0 runtime/client.mjs
 * (`meta = { driverAdapterError: cause }`). `meta.target` - the classic
 * pre-adapter shape - does not exist anywhere in that runtime, so no fallback
 * to it is attempted.
 *
 * `meta.modelName` is 'User' for both indexes, so it cannot disambiguate.
 * Anything unrecognised falls through to a NEUTRAL conflict rather than
 * guessing: a wrong-but-specific message is worse than a vague correct one.
 */
const USER_PHONE_INDEX = 'User_phone_organizationId_key';
const USER_EMAIL_INDEX = 'User_email_organizationId_key';

export function violatedUserIndex(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return null;
  }
  const meta = err.meta as { driverAdapterError?: { cause?: unknown } } | undefined;
  return uniqueIndexFromAdapterCause(meta?.driverAdapterError?.cause);
}

/**
 * Read the violated unique-index name out of a Prisma 7 driver-adapter error
 * PAYLOAD (the part under `meta.driverAdapterError`).
 *
 * Split out from `rethrowAsUserUniquenessConflict` so the path can be
 * unit-tested without fabricating a `PrismaClientKnownRequestError`: a fake
 * class would only prove the parser matches its own assumption about the shape.
 * The REAL shape is exercised by the DB-backed suite in
 * users.service.rls.test.ts, which raises a genuine duplicate.
 *
 * Verified shape (@prisma/adapter-pg@7.10.0, SQLSTATE 23505):
 *   { kind: 'UniqueConstraintViolation', constraint: { index: '<name>' }, table }
 * so `constraint` is an OBJECT with an `index` key - not the string that the
 * older `meta.target` array carried (absent from the 7.10 runtime entirely).
 */
export function uniqueIndexFromAdapterCause(cause: unknown): string | null {
  const index = (cause as { constraint?: { index?: unknown } } | undefined)?.constraint?.index;
  return typeof index === 'string' ? index : null;
}

export function rethrowAsUserUniquenessConflict(err: unknown): never {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    throw err;
  }
  const index = violatedUserIndex(err);
  if (index === USER_PHONE_INDEX) {
    throw new CodedConflictException(
      'PHONE_ALREADY_EXISTS',
      'A user with this phone number already exists in your organization. Use a different number.',
    );
  }
  if (index === USER_EMAIL_INDEX) {
    throw new CodedConflictException(
      'EMAIL_ALREADY_EXISTS',
      'A user with this email already exists in your organization. Use a different email address.',
    );
  }
  // Unknown index: the write still failed on a uniqueness rule, so it is a
  // 409 - but name no field, because naming the wrong one sends the operator
  // to fix something that was not the problem.
  throw new CodedConflictException(
    'USER_UNIQUE_CONFLICT',
    'That change conflicts with an existing user in your organization.',
  );
}

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
}

/**
 * Search terms to try against the digits-only `User.phone` column (2026-11-18).
 *
 * The column stores `919876543210`, but an operator types "98765 43210",
 * "+91 98765 43210" or "098765 43210". A single normalized term covers the
 * full-number case; the RAW digit run is kept as a second alternative so a
 * partial search ("7654", "9876") still matches as a substring instead of
 * being parsed as a malformed full number and dropped.
 *
 * Exported for test: the search clause itself is exercised through `list()`,
 * but the shape decisions here are worth pinning directly.
 */
export function searchPhoneTerms(search: string): string[] {
  const terms = new Set<string>();
  // Partial search stays as typed, minus formatting - never normalized, so
  // "7654" cannot be rewritten into "917654".
  const rawDigits = search.replace(/\D/g, '');
  if (rawDigits.length > 0) terms.add(rawDigits);
  // Full-number search also tries the canonical stored form. Wrapped because
  // normalizePhoneDigits throws on anything it cannot parse, and a search box
  // must never 500 on a half-typed query.
  try {
    const normalized = normalizePhoneDigits(search);
    if (normalized.length >= 7) terms.add(normalized);
  } catch {
    // Not a parseable number - the raw digit run above already covers it.
  }
  return [...terms];
}

/**
 * Result of a self-service profile edit (PATCH /api/users/me). Deliberately
 * narrower than CreatedUser: a self-edit never changes role or team, so
 * returning them would imply a capability the route does not have. `email` is
 * echoed back because the settings page shows it read-only.
 */
export interface UpdatedProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Staff contact number, normalized digits-only. Null when unset (2026-11-18). */
  phone: string | null;
  /** Storage key of the photo, or null after a removal (2026-11-24). */
  avatarKey: string | null;
  /**
   * Ready-to-render URL for `avatarKey`, resolved here rather than in the
   * browser: the provider's public base (or the authenticated BFF path when it
   * has none) is a server concern, and duplicating it in the web is how the two
   * drift apart. Null when the user has no photo.
   */
  imageUrl: string | null;
}

/**
 * What every concern needs from the facade.
 *
 * `client` is resolved ONCE, in the facade's constructor, from
 * `PrismaService.$client`. Each concern then reads it through the base class's
 * getter, which is what keeps the moved bodies verbatim.
 */
export interface UsersDeps {
  readonly client: PrismaClient;
  readonly logger: Logger;
  readonly storage?: StorageProvider;
}

export abstract class UsersBase {
  constructor(private readonly deps: UsersDeps) {}

  protected get client(): PrismaClient {
    return this.deps.client;
  }

  protected get logger(): Logger {
    return this.deps.logger;
  }

  protected get storage(): StorageProvider | undefined {
    return this.deps.storage;
  }

  /**
   * Organisation name and slug per candidate, through the SECURITY DEFINER
   * helper `auth_account_identities`.
   *
   * `Organization` is row-level-security scoped to `app.user_org_id`, and this
   * route runs before anyone is signed in, so a plain read returns nothing. The
   * helper also requires the stored phone to equal the argument, which is what
   * stops it from being an organisation lookup for arbitrary user ids.
   */
  protected async accountIdentities(
    client: PrismaClient,
    userIds: string[],
    phone: string,
  ): Promise<Map<string, { organizationName: string; organizationSlug: string }>> {
    const rows = await client.$queryRaw<
      Array<{ user_id: string; organization_name: string; organization_slug: string }>
    >`SELECT user_id, organization_name, organization_slug
        FROM auth_account_identities(${userIds}::text[], ${phone}::text)`;
    return new Map(
      rows.map((row) => [
        row.user_id,
        { organizationName: row.organization_name, organizationSlug: row.organization_slug },
      ]),
    );
  }

  /**
   * T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolves the single
   * "display team" for a user's `CreatedUser.teamId`/`UserDetail.teamId`
   * response field, now that `User.teamId` is gone. A MANAGER's team is
   * the one they lead (Team.managerId); everyone else's is their most
   * recently assigned ordinary TeamMember row, or null if they have none.
   * This preserves the pre-cutover single-team-per-user CONTRACT for
   * these legacy response shapes even though the underlying model now
   * supports multiple TeamMember rows per user.
   *
   * 2026-11-07 (D8): "oldest" became "newest". "Reports to" is derived from
   * this row, so an additive team link (assignManager's ENGINEER branch, or
   * POST /teams/:id/members) must change the display. With oldest-first the
   * new membership was invisible: the endpoint returned the new teamId while
   * the detail page kept showing the original manager.
   *
   * The caller MUST pass a client bound to an open `withRlsContext`
   * transaction: both `Team` and `TeamMember` are FORCE ROW LEVEL SECURITY,
   * so on the bare client the `app.user_*` GUCs are unset, every row is
   * invisible, and this silently returns null (wrong `teamId` in responses
   * rather than a loud failure).
   */
  protected async resolveDisplayTeamId(
    client: PrismaClient,
    userId: string,
    role: string,
    organizationId: string,
  ): Promise<string | null> {
    if (role === 'MANAGER') {
      const led = await client.team.findFirst({
        // T-ORG-EXPLICIT: scope by org rather than inferring it from the
        // managerId join. `TeamMember` carries a denormalized `organizationId`
        // column precisely so RLS can compare a column instead of a join - the
        // app layer should do the same.
        where: { managerId: userId, deletedAt: null, organizationId },
        orderBy: { createdAt: 'asc' },
      });
      return led?.id ?? null;
    }
    const membership = await client.teamMember.findFirst({
      where: { userId, organizationId },
      // 2026-11-07 (D8): NEWEST membership wins, not oldest. "Reports to" is
      // derived from this row, so when an admin adds a user to a team
      // (assignManager's additive ENGINEER branch, or the team roster) the
      // change has to be visible immediately. With `asc` the display kept
      // pointing at the first team joined while the endpoint reported success.
      // This applies to every non-manager role - a SALES_EXEC on two teams now
      // shows their most recently assigned team's manager.
      //
      // The `teamId` tie-break is NOT cosmetic: `assignedAt` defaults to
      // now(), which Postgres evaluates once per TRANSACTION, not per row. The
      // bulk "reassign all members" path inserts every row in one statement, so
      // a page of memberships can share a timestamp - and with a single sort
      // key the display team would flip arbitrarily between reads. Ordering by
      // id breaks the tie deterministically.
      orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
    });
    return membership?.teamId ?? null;
  }

  /**
   * Every reporting line for one user: each team they belong to, newest first,
   * with that team's manager.
   *
   * WHY THIS EXISTS (2026-11-07 product decision): a staff member may hold
   * several TeamMember rows and their RLS access covers ALL of them, but the
   * surface reported only one manager - the newest team's - so an engineer on
   * Team A (Ramesh) and Team B (Suresh) showed only Suresh, and which name
   * appeared silently flipped when D8 changed the resolver from oldest to
   * newest. An admin had no way to learn the other line existed.
   *
   * MANAGER/ADMIN keep the fixed org-OWNER line (they lead rather than sit in a
   * team); OWNER/CUSTOMER get an empty list (`NONE`). Only `TEAM_MANAGER` roles
   * get team entries, matching every other reporting surface.
   *
   * MUST run inside the caller's `withRlsContext` transaction: Team and
   * TeamMember are FORCE RLS, so on the bare client every row is invisible and
   * this would return [] instead of failing loudly.
   */
  protected async resolveReportingLines(
    client: PrismaClient,
    userId: string,
    role: string,
    organizationId: string,
  ): Promise<TeamReportingLine[]> {
    const target = reportingTargetFor(role as Role);

    if (target === 'NONE') return [];

    if (target === 'ORG_OWNER') {
      const owner = await findOrgOwner(client, organizationId);
      return owner === null ? [] : [{ teamId: '', teamName: 'Organisation', manager: owner }];
    }

    // TEAM_MANAGER: one entry per membership, newest first. Same tie-break as
    // resolveDisplayTeamId - `assignedAt` is evaluated once per transaction, so
    // a bulk insert can produce identical timestamps and the order would
    // otherwise flip between reads.
    const memberships = await client.teamMember.findMany({
      where: { userId, organizationId },
      orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
      select: {
        teamId: true,
        team: {
          select: {
            name: true,
            deletedAt: true,
            manager: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    // A soft-deleted team grants no access, so it is not a reporting line the
    // admin should see advertised.
    return memberships
      .filter((m) => m.team.deletedAt === null)
      .map((m) => ({
        teamId: m.teamId,
        teamName: m.team.name,
        manager: m.team.manager,
      }));
  }

  /**
   * Refuse a photo key the caller must not own (2026-11-24).
   *
   * The key's org segment is checked first because it is free, then the stored
   * bytes are inspected: a key is a claim, the object is the evidence. Both
   * failures are 400 rather than 404, because this is the caller's own profile
   * write and they can act on a clear message.
   */
  protected async assertAvatarKey(actor: JwtPayload, key: string): Promise<void> {
    if (this.storage === undefined) {
      // Fail closed: without a provider nothing can verify the object, and an
      // unverified key is exactly what this guard exists to stop.
      throw new BadRequestException('Photo uploads are not configured on this server');
    }
    if (!keyBelongsToOrg(key, actor.organizationId)) {
      throw new BadRequestException('That photo does not belong to your organisation');
    }
    const info = await this.storage.stat(key);
    if (info === null) {
      throw new BadRequestException('That photo is no longer in storage - upload it again');
    }
    if (!info.mimeType.startsWith('image/')) {
      throw new BadRequestException(
        info.mimeType.startsWith('video/')
          ? 'That file is a video - choose a photo instead'
          : 'That file is not an image',
      );
    }
  }

  /**
   * Display URL for a stored avatar key, or null when there is none.
   *
   * The provider seam decides: ImageKit answers a public CDN URL (world
   * readable, the same policy chat images already follow), local disk has none
   * and falls back to the authenticated BFF path, which the media owner arm now
   * admits for `User.avatarKey`.
   */
  protected avatarUrl(key: string | null): string | null {
    const publicUrl =
      this.storage?.publicUrl === undefined ? undefined : this.storage.publicUrl.bind(this.storage);
    return avatarUrlFor(key, publicUrl);
  }

  /**
   * Best-effort blob cleanup. StorageProvider.delete may throw on a network
   * fault, and a replaced photo is not worth failing a saved profile over: log
   * it and leave the object for a sweep.
   */
  protected async deleteAvatarBlob(key: string): Promise<void> {
    if (this.storage === undefined) return;
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`[users] could not delete replaced avatar ${key}: ${String(error)}`);
    }
  }
}
