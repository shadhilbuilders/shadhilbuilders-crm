// Users service - the user-creation + role-change model (Rounds 17–21).
//
// OWNER (exactly one, seed-only): creates any role except OWNER;
// changes the role of anyone. ADMIN: creates/changes
// MANAGER/TELECALLER/SALES_EXEC. MANAGER: creates TELECALLER/SALES_EXEC in
// their own team. Staff roles: nothing.
//
// Guards on changeRole (client-confirmed Round 20, rename 21): no
// self-role-changes; only OWNER touches ADMIN rows (rank check covers
// this); never assign or revoke OWNER; demoting a manager who still
// leads a team is blocked until members move.
//
// Write paths (T-TEAM-AUTHORITATIVE, 2026-09-13): every method here runs
// inside ONE withRlsContext transaction so the Team/TeamMember reads are
// subject to the actor's GUCs (both tables are FORCE ROW LEVEL SECURITY -
// on the bare client they read as empty) and the business write commits
// atomically with its AuditLog row (AGENTS.md A2/G-1).
//   - User/Account: no RLS, so they behave identically inside the tx.
//   - Team/TeamMember/AuditLog: RLS-enforced; the actor's context is what
//     makes them readable and writable at all.
//   - OWNER travels as ADMIN at the RLS layer (downcast in rls.ts).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  withRlsContext,
  rlsContextFrom,
  type Role,
  type PrismaClient,
} from '@shadhil/database';

import {
  LEAD_IN_ACTIVE_PROJECT,
  PROJECT_ACTIVE,
  PROJECT_TEAM_LIVE,
} from '../common/soft-delete-filters';
import type { JwtPayload } from '@shadhil/auth';

import { canonicalPhoneOrThrow } from '../common/phone';
import { avatarDisplayUrl } from '../storage/media-display';
import { keyBelongsToOrg } from '../storage/media-key-scope';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import type {
  AssignManagerDto,
  CreateUserDto,
  ChangePasswordDto,
  ChangeRoleDto,
  LoginIdentifierDto,
  LoginIdentifierResult,
  UpdateProfileDto,
  UpdateUserDto,
  UserDetail,
  UserFilterDto,
  UserListResult,
} from '@shadhil/api-types';
import {
  isPlaceholderEmail,
  LOGIN_IDENTIFIER_CANDIDATE_CAP,
  normalizePhoneDigits,
  reportingTargetFor,
  reportsToTeamManager,
  type TeamReportingLine,
} from '@shadhil/api-types';
import { PrismaService } from '../prisma/prisma.module';
import { CodedConflictException } from '../common/errors/coded-exception';
import {
  assertCanCreateRole,
  assertCanChangeRole,
  findOrgOwner,
  isAdminClass,
  outranks,
  OWNER,
} from './roles';
import {
  hashPassword,
  TIMING_DUMMY_PASSWORD_HASH,
  upsertCredentialAccount,
  verifyPassword,
  verifyPasswordAsync,
} from './credentials';
import { looksLikeEmail, normalisePhoneIdentifier, verifyWithSlot } from './login-identifier';

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

function violatedUserIndex(err: unknown): string | null {
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

function rethrowAsUserUniquenessConflict(err: unknown): never {
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

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    /**
     * StorageModule is @Global and exports this token, so the app always
     * supplies it. Optional ONLY so the two dozen unit tests that construct
     * `new UsersService(prisma)` without a storage double keep compiling.
     *
     * A missing provider fails CLOSED instead of silently skipping the check:
     * `assertAvatarKey` refuses any photo key when it is absent, so a
     * misconfigured module cannot become an unvalidated write path.
     */
    @Optional()
    @Inject(STORAGE_PROVIDER)
    private readonly storage?: StorageProvider,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Resolve "email or phone + password" into the address the browser should
   * sign in with. PUBLIC path: no JWT, no RLS context.
   *
   * Two rules shape the whole method:
   *
   *   1. Every failure looks the same from outside. A malformed identifier, a
   *      phone with no account and a wrong password all answer `invalid`, and
   *      the controller returns 200 for all three (see `LoginIdentifierResult`).
   *   2. A request with no candidate still pays for one full scrypt, against a
   *      throwaway hash, so "no such account" cannot be told from "wrong
   *      password" by timing.
   *
   * The password is checked against the stored credential hash rather than
   * through better-auth: this route only answers "which address?", and the
   * browser then calls the ordinary sign-in with it, so sessions, cookies and
   * every better-auth hook stay on the path that already works.
   *
   * A number shared by two accounts is NOT an error. `Invite.phone` and
   * `User.phone` are deliberately non-unique (a site phone is shared), so the
   * picker exists: the password filters the candidates first, and only the ones
   * it matched are ever named.
   */
  async resolveLoginIdentifier(dto: LoginIdentifierDto): Promise<LoginIdentifierResult> {
    // User and Account are pre-RLS auth tables, so the bare client is correct.
    const client = this.client;
    const identifier = dto.identifier.trim();

    if (looksLikeEmail(identifier)) {
      const user = await client.user.findFirst({
        where: {
          email: identifier.toLowerCase(),
          deletedAt: null,
          // `banned` is NULLABLE, so `banned: false` alone would exclude every
          // row that has never been touched - the same trap the assignee
          // picker documents at :1781.
          OR: [{ banned: false }, { banned: null }],
        },
        select: { id: true, email: true },
      });
      const hash = user === null ? null : await this.credentialHash(client, user.id);
      const matches = await verifyWithSlot(dto.password, hash ?? TIMING_DUMMY_PASSWORD_HASH);
      return user !== null && hash !== null && matches
        ? { kind: 'ok', email: user.email }
        : { kind: 'invalid' };
    }

    const phone = normalisePhoneIdentifier(identifier);
    if (phone === null) {
      await verifyWithSlot(dto.password, TIMING_DUMMY_PASSWORD_HASH);
      return { kind: 'invalid' };
    }

    const candidates = await client.user.findMany({
      where: {
        phone,
        deletedAt: null,
        OR: [{ banned: false }, { banned: null }],
      },
      select: { id: true, email: true, name: true, role: true },
      orderBy: { id: 'asc' },
      take: LOGIN_IDENTIFIER_CANDIDATE_CAP,
    });
    if (candidates.length === 0) {
      await verifyWithSlot(dto.password, TIMING_DUMMY_PASSWORD_HASH);
      return { kind: 'invalid' };
    }

    // Sequential on purpose: the semaphore caps concurrent scrypt work anyway,
    // and a phone shared by five accounts already costs five hashes.
    const matched: typeof candidates = [];
    for (const candidate of candidates) {
      const hash = await this.credentialHash(client, candidate.id);
      if (hash !== null && (await verifyWithSlot(dto.password, hash))) {
        matched.push(candidate);
      }
    }
    const first = matched[0];
    if (first === undefined) return { kind: 'invalid' };
    if (matched.length === 1) return { kind: 'ok', email: first.email };

    const identities = await this.accountIdentities(
      client,
      matched.map((m) => m.id),
      phone,
    );

    // Second attempt from the picker: the person chose a specific account. It
    // must be one whose password already matched, so the handle cannot be used
    // to point at somebody else's row.
    if (dto.accountUserId !== undefined) {
      const chosen = matched.find((m) => m.id === dto.accountUserId);
      return chosen === undefined ? { kind: 'invalid' } : { kind: 'ok', email: chosen.email };
    }

    const accounts = matched.flatMap((m) => {
      const identity = identities.get(m.id);
      if (identity === undefined) return [];
      return [
        {
          userId: m.id,
          name: m.name,
          organizationName: identity.organizationName,
          organizationSlug: identity.organizationSlug,
          role: m.role,
        },
      ];
    });
    if (accounts.length === 0) return { kind: 'invalid' };
    if (accounts.length === 1) return { kind: 'ok', email: first.email };
    return { kind: 'pick', accounts };
  }

  /** Stored password hash for a user's credential account, or null. */
  private async credentialHash(client: PrismaClient, userId: string): Promise<string | null> {
    const account = await client.account.findFirst({
      where: { userId, providerId: 'credential', issuer: 'local:credential' },
      select: { password: true },
    });
    return account?.password ?? null;
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
  private async accountIdentities(
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
  private async resolveDisplayTeamId(
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
  private async resolveReportingLines(
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

  async create(actor: JwtPayload, dto: CreateUserDto): Promise<CreatedUser> {
    const actorRole = actor.role;
    const actorIsManager = actorRole === 'MANAGER';
    // Org-owner class: OWNER behaves like ADMIN on this surface
    // (create into any team; auto-team for MANAGER targets).
    const actorIsOrgOwner = actorRole === 'OWNER' || actorRole === 'ADMIN';

    // 1. Role hierarchy gate (fails closed for any staff role).
    assertCanCreateRole(actorRole, dto.role);

    // 1b. Issue #8 slice 2: customerLeadId <-> CUSTOMER is a strict pairing,
    //     and a customer belongs to no team. Shape rules fail before any I/O.
    if (dto.role === 'CUSTOMER') {
      if (dto.customerLeadId === undefined) {
        throw new BadRequestException('customerLeadId is required when creating a CUSTOMER user');
      }
      if (dto.teamId !== undefined) {
        throw new BadRequestException('A CUSTOMER user belongs to no team - omit teamId');
      }
      // 2026-11-18 (user-phone): a buyer's number lives on their LEAD. Storing
      // a second copy here would create two truths for one person and, with the
      // per-org phone index, would make the second login on a jointly-bought
      // flat fail with a 409 (spec D2). Reject rather than silently ignore, so
      // the caller learns the rule instead of believing the write landed.
      if (dto.phone !== undefined && dto.phone !== null) {
        throw new BadRequestException(
          'A CUSTOMER has no phone of their own - update the number on their lead instead',
        );
      }
    } else if (dto.customerLeadId !== undefined) {
      throw new BadRequestException('customerLeadId is only valid for CUSTOMER users');
    }

    // Everything below runs in ONE RLS transaction: the Team reads are
    // FORCE ROW LEVEL SECURITY (unreadable on the bare client), and the
    // user + credential + team + membership + audit writes must all commit
    // or all roll back (replaces the previous manual compensating delete;
    // AGENTS.md A2/G-1). User/Account have no RLS so they behave the same
    // inside the transaction; Team/TeamMember require the actor's GUCs.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 2. Resolve the target team.
      let teamId = dto.teamId ?? null;

      if (actorIsManager) {
        // T-TEAM-AUTHORITATIVE (2026-09-13): the manager's team(s) are
        // resolved authoritatively via Team.managerId (a manager may lead
        // multiple teams) - the JWT teamId claim is unreliable. An
        // explicit dto.teamId must be one of THEIR teams; omitted defaults
        // to their first (oldest) managed team.
        const managedTeams = await client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (managedTeams.length === 0) {
          throw new ForbiddenException('You do not manage any team');
        }
        if (dto.teamId !== undefined) {
          if (!managedTeams.some((t) => t.id === dto.teamId)) {
            throw new ForbiddenException('You can only create users in a team you manage');
          }
          teamId = dto.teamId;
        } else {
          teamId = managedTeams[0]!.id;
        }
      } else if (
        actorIsOrgOwner &&
        dto.role !== 'ADMIN' &&
        dto.role !== 'CUSTOMER' &&
        !dto.teamId
      ) {
        // Admin creating a manager WITHOUT teamId: auto-create the team.
        // Admin creating a STAFF user without teamId: reject - ambiguous.
        if (dto.role === 'MANAGER') {
          // Handled post-user-creation (needs the user id).
        } else {
          throw new BadRequestException(
            'teamId is required when an admin creates TELECALLER/SALES_EXEC/ENGINEER users',
          );
        }
      }

      // 3. Reject a stale teamId that doesn't exist, or a soft-deleted one
      //    (pre-FK clarity; deletedAt treated as absent to match the
      //    active-team checks elsewhere).
      if (teamId) {
        const team = await client.team.findUnique({ where: { id: teamId } });
        if (!team || team.deletedAt !== null) {
          throw new NotFoundException(`Team ${teamId} not found`);
        }
      }

      // 3b. The lead a CUSTOMER points at must exist IN THIS ORG. Read under
      //     the actor's context (admin class sees the org's leads); a lead in
      //     another org reads as absent, which is the answer we want.
      if (dto.role === 'CUSTOMER') {
        const lead = await client.lead.findFirst({
          where: { id: dto.customerLeadId, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.customerLeadId} not found`);
        }
      }

      // 4. Create user + credential + (team for new managers) + TeamMember
      //    row + audit row.
      //
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId is gone
      // - TeamMember is the sole membership record now. A TELECALLER/
      // SALES_EXEC (or a MANAGER's own ordinary membership, if ever given
      // one through this path) gets a TeamMember row for `teamId` instead of
      // a scalar column write.
      // T-EMAIL-PER-ORG: the unique constraint is (email, organizationId) -
      // a P2002 here means this email is already taken within THIS org. The
      // phone partial index added 2026-11-18 can also throw P2002, which the
      // mapper attributes by constraint name before choosing the message.
      const created = await client.user
        .create({
          data: {
            email: dto.email,
            name: dto.name,
            role: dto.role,
            emailVerified: false,
            organizationId: actor.organizationId,
            // 2026-11-18 (user-phone): staff contact number. Already normalized
            // by ClearablePhoneSchema. Absent for CUSTOMER (rejected in 1b) and
            // undefined when the caller omitted it, which Prisma writes as NULL.
            ...(dto.role === 'CUSTOMER'
              ? {}
              : { phone: canonicalPhoneOrThrow(dto.phone, dto.phoneCountry) }),
            ...(dto.role === 'CUSTOMER' ? { customerLeadId: dto.customerLeadId } : {}),
            // issue #8 slice 2 (D3): a buyer's login is PROVISIONED by staff
            // with a temporary password that was read out over WhatsApp and
            // typed by somebody else. Spec D3 promises the existing gate
            // forces a rotation on first login, but the column defaults to
            // false and nothing outside the seed's OWNER arm ever set it - so
            // a customer would have sat on `customer_placeholder_pw`
            // indefinitely. Arm it here, for CUSTOMER only: staff roles keep
            // the ungated default chosen in migration 20260915160000.
            //
            // The gate is enforced by JwtAuthGuard (403 PASSWORD_CHANGE_REQUIRED,
            // which the BFF routes to /change-password) and cleared by
            // changePassword() in this same service.
            ...(dto.role === 'CUSTOMER' ? { mustChangePassword: true } : {}),
          },
        })
        .catch(rethrowAsUserUniquenessConflict);

      await upsertCredentialAccount(client, created.id, dto.password);

      // Auto-create the team for a new manager (org-owner creating
      // MANAGER without an explicit teamId). A manager's OWN leadership is
      // Team.managerId, not a TeamMember row - no membership row needed.
      if (dto.role === 'MANAGER' && actorIsOrgOwner && !dto.teamId) {
        const team = await client.team.create({
          data: {
            name: `${dto.name}'s Team`,
            managerId: created.id,
            organizationId: actor.organizationId,
          },
        });
        teamId = team.id;
      } else if (teamId !== null) {
        // TELECALLER/SALES_EXEC (or a manager given an explicit team they
        // don't lead) get an ordinary TeamMember row.
        await client.teamMember.create({
          data: {
            userId: created.id,
            teamId,
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });
      }

      // Audit row - same transaction; a failure here rolls back the user,
      // so there is never an un-credentialed or unlogged account.
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.create',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: created.id,
          after: {
            email: created.email,
            role: created.role,
            createdBy: actor.sub,
            ...(dto.role === 'CUSTOMER' ? { customerLeadId: dto.customerLeadId } : {}),
          },
          reason: `user.create by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
        teamId: teamId ?? null,
      };
    });
  }

  async changeRole(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangeRoleDto,
  ): Promise<CreatedUser> {
    // The Team reads (demotion guard + promotion auto-team) and the
    // resolveDisplayTeamId lookup are FORCE ROW LEVEL SECURITY, so they
    // need the actor's GUCs; the role write and its audit row share one
    // transaction (AGENTS.md A2/G-1).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 1. Target must exist.
      const target = await client.user.findUnique({
        where: { id: targetUserId },
      });
      if (!target) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // 2. Absolute guard: nobody changes their own role (not even the
      //    owner - role changes on self are how orgs get locked out).
      if (target.id === actor.sub) {
        throw new ForbiddenException('You cannot change your own role');
      }

      // 3. Role-level hierarchy (includes: OWNER unassignable,
      //    only owner touches ADMIN rows, actor must strictly outrank both
      //    the target's current role and the new role).
      assertCanChangeRole(actor.role, target.role as Role, dto.role);

      // 3b. Issue #8: a CUSTOMER cannot be minted by a role change - it needs a
      //     lead pointer, which only create() collects. Provision a new
      //     customer account instead.
      if (dto.role === 'CUSTOMER' && target.role !== 'CUSTOMER') {
        throw new BadRequestException(
          'A user cannot be changed into a CUSTOMER - create a customer account with a linked lead instead',
        );
      }

      // 4. Demotion guard: a manager still leading a team cannot be demoted.
      if (target.role === 'MANAGER' && dto.role !== 'MANAGER') {
        const ledTeam = await client.team.findFirst({
          where: { managerId: target.id, deletedAt: null },
        });
        if (ledTeam) {
          throw new ConflictException(
            `User still leads team "${ledTeam.name}" - move its members or reassign the team before demoting`,
          );
        }
      }

      // 5. Promotion to MANAGER: ensure a team exists (consistent with the
      //    create flow - managers always lead exactly one team). A role
      //    change does NOT touch the target's ordinary TeamMember row(s) -
      //    that's a separate concern from role/leadership, and the demotion
      //    guard above already blocks demoting a manager who still leads a
      //    team, so there's nothing to clean up on the way down either.
      if (dto.role === 'MANAGER' && target.role !== 'MANAGER') {
        const existing = await client.team.findFirst({
          where: { managerId: target.id },
        });
        if (!existing) {
          await client.team.create({
            data: {
              name: `${target.name}'s Team`,
              managerId: target.id,
              organizationId: actor.organizationId,
            },
          });
        }
      }

      const updated = await client.user.update({
        where: { id: target.id },
        // A role change away from CUSTOMER clears the lead pointer in the SAME
        // write (spec): a stale pointer on a staff row would be dead data that
        // the customer helpers must never be trusted to ignore.
        data: {
          role: dto.role,
          ...(target.role === 'CUSTOMER' && dto.role !== 'CUSTOMER'
            ? { customerLeadId: null }
            : {}),
        },
      });
      const teamId = await this.resolveDisplayTeamId(
        client,
        updated.id,
        updated.role,
        actor.organizationId,
      );

      // 6. Audit row in the same transaction (OWNER downcasts to ADMIN at
      //    the RLS layer - rls.ts).
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.changeRole',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { role: target.role },
          after: { role: dto.role },
          reason: `role change by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        teamId,
      };
    });
  }

  /**
   * PATCH /api/users/:id - edit a user's name/email/phone (autoplan
   * 2026-09-09; phone 2026-11-18). Hierarchy-gated: the actor must strictly
   * outrank the target (no self-edit, OWNER protected). Mirrors the
   * changeRole guards.
   */
  async update(actor: JwtPayload, targetUserId: string, dto: UpdateUserDto): Promise<CreatedUser> {
    // One RLS transaction: resolveDisplayTeamId reads the FORCE-RLS
    // Team/TeamMember tables, and the user write + audit row must commit
    // atomically (AGENTS.md A2/G-1).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 1. Target must exist IN THIS ORG.
      //
      // T-ORG-EXPLICIT (2026-11-18): this read used to be a bare
      // `findUnique({ id })`. `User` carries NO row-level security (verified in
      // the live DB: relrowsecurity = false), so without this filter an ADMIN in
      // org A could edit a user in org B by guessing an id. It also matters more
      // now than it did: the phone index added by this slice is scoped
      // (phone, organizationId), so a cross-tenant caller could otherwise force
      // a 409 inside the victim org's namespace.
      //
      // A cross-org id now reads as absent, which is the answer we want - the
      // same "not found" a genuinely missing row produces.
      const target = await client.user.findFirst({
        where: { id: targetUserId, organizationId: actor.organizationId },
      });
      if (!target) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // 2. No self-edit (an admin shouldn't rename their own account here;
      //    self-profile editing is a separate surface).
      if (target.id === actor.sub) {
        throw new ForbiddenException('You cannot edit your own user');
      }

      // 3. Hierarchy: actor must strictly outrank the target. OWNER is
      //    protected (nobody outranks it).
      if (!outranks(actor.role, target.role as Role)) {
        throw new ForbiddenException(`${actor.role} cannot edit a ${target.role} user`);
      }

      // 3b. A CUSTOMER is administrable ONLY by the admin class.
      //
      // The rank table puts CUSTOMER at 1 and MANAGER at 2, so `outranks` above
      // lets a MANAGER through. roles.ts states the rule explicitly ("MANAGER
      // may never touch a CUSTOMER row") and enforces it on create and on role
      // change - but this path did not, so a manager could rename a buyer's
      // account and rewrite their LOGIN EMAIL. Fixed here (2026-11-18).
      if (target.role === 'CUSTOMER' && !isAdminClass(actor.role)) {
        throw new ForbiddenException('Only ADMIN or OWNER can edit a CUSTOMER account');
      }

      // 3c. A CUSTOMER has no phone of their own - it lives on their lead.
      //     Reject rather than silently dropping it, so the caller is told.
      if (target.role === 'CUSTOMER' && dto.phone !== undefined) {
        throw new BadRequestException(
          'A CUSTOMER has no phone of their own - update the number on their lead instead',
        );
      }

      // 4. Apply the update (only the provided fields).
      const data: { name?: string; email?: string; phone?: string | null } = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.email !== undefined) data.email = dto.email;
      // `null` is the erase path (ClearablePhoneSchema); undefined means
      // "omitted", which must leave the stored number untouched.
      if (dto.phone !== undefined) {
        data.phone = canonicalPhoneOrThrow(dto.phone, dto.phoneCountry);
      }

      // T-EMAIL-PER-ORG: a P2002 here means the new email is already taken
      // by someone else within THIS org, OR on the phone index - the error
      // mapper above distinguishes them by constraint name.
      const updated = await client.user
        .update({
          where: { id: target.id },
          data,
        })
        .catch(rethrowAsUserUniquenessConflict);

      // 5. Audit row - same transaction.
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.update',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { name: target.name, email: target.email, phone: target.phone },
          after: { name: updated.name, email: updated.email, phone: updated.phone },
          reason: `user.update by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        teamId: await this.resolveDisplayTeamId(
          client,
          updated.id,
          updated.role,
          actor.organizationId,
        ),
      };
    });
  }

  /**
   * PATCH /api/users/me - SELF-service profile edit (settings page, 2026-09-18).
   *
   * The one profile write a user may perform on themselves. Distinct from
   * `update()` above, which is the ADMIN surface and deliberately REFUSES
   * self-edits ("self-profile editing is a separate surface").
   *
   * Authorization is by CONSTRUCTION, not by a role check: the target id comes
   * from the verified JWT `sub` and the route takes no id parameter, so there
   * is no id a caller could supply to reach someone else's row. The write is
   * additionally pinned to `actor.sub` in the `where` clause rather than
   * trusting the earlier read (a TOCTOU-safe shape).
   *
   * Fields: `name` only. Email is excluded because this deployment has no
   * email-verification flow - see UpdateProfileDtoSchema's comment.
   *
   * RLS note: `User` carries NO row-level security (verified in the live DB:
   * relrowsecurity = false), so - like `changePassword` - the row scope here
   * is the code above, not a policy. The AuditLog row still runs inside the
   * actor's RLS context, because THAT table is FORCE RLS and the insert policy
   * gates on app.user_id.
   */
  async updateSelf(actor: JwtPayload, dto: UpdateProfileDto): Promise<UpdatedProfile> {
    // 1. Read the current value first so the audit row can carry a real
    //    before/after pair (and so a no-op change can be reported as such).
    const before = await this.client.user.findUnique({
      where: { id: actor.sub },
      select: { id: true, name: true, email: true, role: true, phone: true, avatarKey: true },
    });
    if (before === null) {
      // The JWT is valid but the row is gone (hard-deleted account). Fail
      // loudly rather than silently succeeding on nothing.
      throw new NotFoundException(`User ${actor.sub} not found`);
    }

    // 1b. A CUSTOMER has no phone of their own (2026-11-18). The DTO has no
    //     role to inspect, so the rule lives here: their number belongs to the
    //     lead, which is the WhatsApp identity key. Silently dropping the field
    //     would tell a buyer their number saved when nothing changed.
    if (before.role === 'CUSTOMER' && dto.phone !== undefined) {
      throw new BadRequestException(
        'Your account has no phone of its own - contact the project office to update your number',
      );
    }

    // 1c. Email self-service (2026-11-21), narrow on purpose.
    //
    // A user may REPLACE a generated `noemail+<hex>@users.invalid` address with
    // a real one. They may NOT move from one real address to another: this
    // deployment has no email verification, so that would repoint the login at a
    // mailbox nobody has proven they own. Real-to-real stays with ADMIN/OWNER
    // through PATCH /api/users/:id.
    if (dto.email !== undefined) {
      if (!isPlaceholderEmail(before.email)) {
        throw new BadRequestException(
          'Your email is already set. Ask an administrator to change it.',
        );
      }
      if (dto.currentPassword === undefined) {
        // The DTO already requires it; this is the belt-and-braces check for a
        // caller that bypasses validation.
        throw new BadRequestException('Enter your current password to change your email address');
      }
      const credential = await this.client.account.findFirst({
        where: { userId: actor.sub, providerId: 'credential', issuer: 'local:credential' },
        select: { password: true },
      });
      const correct = await verifyPasswordAsync(dto.currentPassword, credential?.password ?? null);
      if (!correct) {
        throw new BadRequestException('That password is not correct.');
      }
    }

    // 1d. An account must keep ONE usable login identifier. Clearing the phone
    //     while the address is still a placeholder would leave nothing the
    //     person can sign in with, and the synthetic address is never shown
    //     to them.
    const clearingPhone = dto.phone === null;
    const emailStaysPlaceholder = dto.email === undefined && isPlaceholderEmail(before.email);
    if (clearingPhone && emailStaysPlaceholder) {
      throw new BadRequestException(
        'Add an email address before removing your phone number - otherwise you could not sign in.',
      );
    }

    // 1e. A photo key is not trusted because it parsed as a string (2026-11-24).
    //     Two checks run before it can reach the row: the key must sit in the
    //     caller's own org namespace (otherwise a tenant could point at another
    //     tenant's object), and the STORED bytes must be an image. The upload
    //     route records the type from the bytes, but it falls back to the
    //     client's declaration for formats it cannot identify, so a stat is the
    //     only honest check. Clearing the photo (null) skips both.
    if (typeof dto.avatarKey === 'string') {
      await this.assertAvatarKey(actor, dto.avatarKey);
    }

    // 2. Write + audit atomically: the audit row must not survive a failed
    //    write, and the write must not land unaudited (AGENTS.md A2/G-1).
    //    One RLS transaction (AuditLog is FORCE RLS; User is not, but sharing
    //    the tx keeps the pair atomic).
    const saved = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // Only the provided fields. `phone: null` is the erase path; undefined
      // means the caller did not touch it. The DTO's refinement guarantees at
      // least one field is present, so this is never an empty write.
      const data: {
        name?: string;
        phone?: string | null;
        email?: string;
        emailVerified?: boolean;
        avatarKey?: string | null;
      } = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.phone !== undefined) {
        data.phone = canonicalPhoneOrThrow(dto.phone, dto.phoneCountry);
      }
      if (dto.email !== undefined) {
        data.email = dto.email;
        // Nothing has proven the new address yet, so it is stored unverified.
        // The moment a mailer exists, the reset path must be gated on this.
        data.emailVerified = false;
      }
      // `null` clears the photo; undefined means the caller did not touch it.
      if (dto.avatarKey !== undefined) data.avatarKey = dto.avatarKey;

      const updated = await client.user
        .update({
          where: { id: actor.sub },
          data,
          select: { id: true, name: true, email: true, role: true, phone: true, avatarKey: true },
        })
        .catch(rethrowAsUserUniquenessConflict);

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.updateSelf',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: actor.sub,
          before: {
            name: before.name,
            phone: before.phone,
            email: before.email,
            avatarKey: before.avatarKey,
          },
          after: {
            name: updated.name,
            phone: updated.phone,
            email: updated.email,
            avatarKey: updated.avatarKey,
          },
          reason: `profile updated by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        phone: updated.phone,
        avatarKey: updated.avatarKey,
        imageUrl: this.avatarUrl(updated.avatarKey),
      };
    });

    // 3. Drop the replaced blob AFTER the row has committed, and never fail the
    //    save on it: a stale object is a storage bill, a failed save is a user
    //    who believes their photo did not save. Deleting before the write would
    //    lose the old photo whenever the row write failed.
    if (before.avatarKey !== null && before.avatarKey !== saved.avatarKey) {
      await this.deleteAvatarBlob(before.avatarKey);
    }

    return saved;
  }

  /**
   * Refuse a photo key the caller must not own (2026-11-24).
   *
   * The key's org segment is checked first because it is free, then the stored
   * bytes are inspected: a key is a claim, the object is the evidence. Both
   * failures are 400 rather than 404, because this is the caller's own profile
   * write and they can act on a clear message.
   */
  private async assertAvatarKey(actor: JwtPayload, key: string): Promise<void> {
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
  private avatarUrl(key: string | null): string | null {
    const direct = key === null ? null : (this.storage?.publicUrl?.(key) ?? null);
    return avatarDisplayUrl(key, direct)?.url ?? null;
  }

  /**
   * Best-effort blob cleanup. StorageProvider.delete may throw on a network
   * fault, and a replaced photo is not worth failing a saved profile over: log
   * it and leave the object for a sweep.
   */
  private async deleteAvatarBlob(key: string): Promise<void> {
    if (this.storage === undefined) return;
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`[users] could not delete replaced avatar ${key}: ${String(error)}`);
    }
  }

  /**
   * DELETE /api/users/:id - SOFT delete a user (autoplan 2026-09-09).
   * ADMIN/OWNER only. Sets User.deletedAt (no hard delete): the account row
   * is kept so audit/history survive, but the user cannot sign in and is
   * hidden from every list/picker. No self-delete; OWNER is protected.
   */
  async remove(actor: JwtPayload, targetUserId: string): Promise<{ ok: true }> {
    // 0. Admin/owner only.
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can delete users.');
    }

    // 1. Target must exist + not already deleted + not OWNER.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }
    if (target.role === OWNER) {
      throw new ForbiddenException('The OWNER cannot be deleted.');
    }

    // 2. No self-delete.
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot delete your own user');
    }

    // 3. Soft delete: stamp deletedAt (keep the account row).
    await this.client.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });

    // 4. Audit row in the actor's RLS context.
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.delete',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { name: target.name, email: target.email, role: target.role },
          reason: `user.delete (soft) by ${actor.email} (${actor.role})`,
        },
      });
    });

    return { ok: true };
  }

  /**
   * GET /api/users/:id - the user detail page (users/[userId], autoplan
   * 2026-09-13). Scope mirrors `list()`: OWNER/ADMIN see anyone; MANAGER
   * sees their own team's members (+ themselves); staff see only
   * themselves. `manager` ("Reports to") is populated per role:
   *   - TELECALLER/SALES_EXEC: their resolved team's manager (assignable,
   *     see `assignManager` below).
   *   - MANAGER/ADMIN: the org OWNER (T-REPORTS-TO-OWNER - fixed, never
   *     assignable; see `findOrgOwner`).
   *   - OWNER: null (reports to nobody).
   */
  async getUser(actor: JwtPayload, targetUserId: string): Promise<UserDetail> {
    // The Team/TeamMember reads below are FORCE ROW LEVEL SECURITY, so the
    // whole lookup runs in one RLS transaction with the actor's GUCs -
    // otherwise `resolveDisplayTeamId` returns null and the response
    // silently reports teamId/teamName/manager/projects as empty.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      const target = await client.user.findUnique({
        where: { id: targetUserId, deletedAt: null },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          // 2026-11-18: staff phone + the customer's lead pointer. A CUSTOMER
          // has no phone of their own; theirs is derived from the lead below.
          phone: true,
          // 2026-11-24: the photo key. Resolved to a URL below, because the
          // provider's public base is a server concern and the web must never
          // build a media path of its own.
          avatarKey: true,
          customerLeadId: true,
        },
      });
      if (target === null) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId/the
      // legacy singular `team` relation are gone - resolve the target's
      // display team via the same rule as create()/changeRole()
      // (resolveDisplayTeamId), then fetch that team's manager + linked
      // projects (ProjectTeam) separately.
      const teamId = await this.resolveDisplayTeamId(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );
      const team =
        teamId !== null
          ? await client.team.findUnique({
              where: { id: teamId },
              select: {
                id: true,
                name: true,
                manager: { select: { id: true, name: true, email: true } },
                // "Which projects" is "which projects is this user's TEAM
                // linked to" (ProjectTeam) - ProjectMember (per-user
                // linking) was retired. Read-only here (linking happens on
                // the project's Staff page, at the team level).
                // T-SOFT-DELETE: a link to a soft-deleted project must not
                // surface as one of this user's projects.
                projectTeams: {
                  where: { project: { deletedAt: null } },
                  select: { project: { select: { id: true, name: true } } },
                  orderBy: { project: { name: 'asc' } },
                },
              },
            })
          : null;

      // Scope check - mirrors list()'s role lanes.
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        // sees anyone.
      } else if (actor.role === 'MANAGER') {
        // T-TEAM-AUTHORITATIVE (2026-09-13): a manager may lead multiple
        // teams - check membership in the FULL managed-team set.
        const teams = await client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null },
          select: { id: true },
        });
        const inOwnTeam = teamId !== null && teams.some((t) => t.id === teamId);
        if (!inOwnTeam && target.id !== actor.sub) {
          throw new ForbiddenException("You can only view your own team's users");
        }
      } else if (target.id !== actor.sub) {
        throw new ForbiddenException('You can only view your own user');
      }

      // T-REPORTS-TO-OWNER: "manager" is this user's reporting-line
      // superior, and WHO that is depends on the target's own role, not a
      // single rule. TELECALLER/SALES_EXEC/ENGINEER report to their team's
      // manager (assignable); MANAGER/ADMIN report to the org OWNER (fixed);
      // OWNER/CUSTOMER report to nobody.
      //
      // 2026-11-07: the role check is a shared, EXHAUSTIVE map
      // (@shadhil/api-types reportingTargetFor) rather than an inline union.
      // ENGINEER was missing here for three weeks because the union was not
      // exhaustive and TypeScript had no way to object.
      const reportsToManager = reportsToTeamManager(target.role as Role);
      const reportsToOwner = reportingTargetFor(target.role as Role) === 'ORG_OWNER';

      // The full list of lines (2026-11-07): every team this user is on, with
      // that team's manager, newest first.
      const reportsTo = await this.resolveReportingLines(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );

      // `manager` is the single-value view the existing card and the assign
      // button read, DERIVED from the list rather than fetched separately.
      //
      // Deriving matters beyond tidiness: before this, MANAGER/ADMIN rows hit
      // findOrgOwner twice per getUser (once here, once in the resolver), which
      // is a wasted round trip on every user detail view and made the two
      // values free to disagree if the org's OWNER changed between the calls.
      //
      // Null for OWNER/CUSTOMER: resolveReportingLines returns [] for NONE, and
      // for a team with no manager the first line's manager is null - both of
      // which are the answers this field already gave.
      const primaryManager = reportsTo[0]?.manager ?? null;

      // Every team this user belongs to, newest first - the "assign manager"
      // picker excludes them all. `teamId` above is only the DISPLAY team, so
      // a two-team engineer could otherwise "assign" to a team they are
      // already on and get a success toast for a no-op (2026-11-07).
      const allMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
        // Same tie-break as resolveDisplayTeamId (see the note there).
        orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
      });

      // 2026-11-18: a CUSTOMER's number lives on their lead, never on the
      // account. Read under the actor's RLS context, which is safe for the
      // roles that can reach a customer row here: ADMIN/OWNER hold
      // lead_select_admin. A MANAGER is already 403'd above (a customer has no
      // team), and a buyer reading THEMSELF never lands here - `Lead` has no
      // CUSTOMER SELECT policy, so that read would return zero rows silently
      // rather than erroring. A missing/soft-deleted lead reads as null.
      const derivedCustomerPhone =
        target.role === 'CUSTOMER' && target.customerLeadId !== null
          ? ((
              await client.lead.findFirst({
                where: {
                  id: target.customerLeadId,
                  organizationId: actor.organizationId,
                },
                select: { phone: true },
              })
            )?.phone ?? null)
          : null;

      return {
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        phone: target.role === 'CUSTOMER' ? derivedCustomerPhone : (target.phone ?? null),
        phoneSource: target.role === 'CUSTOMER' ? 'LEAD' : 'USER',
        // `?? null`, not the raw column: a fixture or a pre-migration row can
        // read as undefined, and the DTO promises a nullable string.
        avatarKey: target.avatarKey ?? null,
        imageUrl: this.avatarUrl(target.avatarKey ?? null),
        teamId,
        teamName: team?.name ?? null,
        teamIds: allMemberships.map((m) => m.teamId),
        manager: primaryManager,
        reportsTo,
        // T-ORG-OWNER-ACCESS (2026-09-17): OWNER/ADMIN see every project in
        // the org; staff see the projects linked to their resolved team.
        projects:
          target.role === 'OWNER' || target.role === 'ADMIN'
            ? (
                await client.project.findMany({
                  where: {
                    organizationId: actor.organizationId,
                    // T-SOFT-DELETE: same registry filter as the admin list
                    // branch - a deleted project is not one of "their" projects.
                    ...PROJECT_ACTIVE,
                  },
                  select: { id: true, name: true },
                  orderBy: { name: 'asc' },
                })
              ).map((p) => ({ id: p.id, name: p.name }))
            : (team?.projectTeams ?? []).map((pt) => ({
                id: pt.project.id,
                name: pt.project.name,
              })),
      };
    });
  }

  /**
   * PATCH /api/users/:id/manager - assign/reassign the reporting line for a
   * TELECALLER/SALES_EXEC/ENGINEER (autoplan 2026-09-13; ENGINEER 2026-11-07).
   * "Manager" is a reporting-line concept derived from `Team.managerId`, so
   * this sets the target's membership in the chosen team.
   *
   * TWO WRITE MODES, chosen by the TARGET's role:
   *
   *   - TELECALLER / SALES_EXEC -> MOVE. Replaces the target's ordinary
   *     TeamMember row(s) with one for the chosen team. Safe for these roles:
   *     their work comes from lead ownership, not team membership.
   *
   *   - ENGINEER -> ADDITIVE. Never deletes. An engineer's ENTIRE RLS surface
   *     (units, phases, progress photos) is derived from TeamMember ->
   *     ProjectTeam joins, so a move would silently revoke access to every
   *     project staffed by their previous team(s). Adding them to a second
   *     team is the normal way to give an engineer another project.
   *
   * Scope:
   *   - OWNER/ADMIN: assign to any existing (led) team.
   *   - MANAGER: only into their OWN team - they can't poach staff into
   *     another manager's team. In practice `getUser`'s scope check
   *     already means a MANAGER only reaches this for a user already in
   *     their own team, but the team-ownership check here is the actual
   *     gate (belt-and-braces, same pattern as `list()`'s where-clause
   *     comment). ENGINEER targets are further restricted to the admin class
   *     (below) - team membership IS the project-access grant.
   *   - staff: never - `outranks()` fails closed (RANK[staff] never
   *     exceeds RANK[staff]).
   */
  async assignManager(
    actor: JwtPayload,
    targetUserId: string,
    dto: AssignManagerDto,
  ): Promise<CreatedUser> {
    // 1-6 run inside ONE RLS transaction so the Team/TeamMember reads are
    // subject to the actor's GUCs (they are FORCE ROW LEVEL SECURITY) and
    // the membership replace + audit row commit atomically (AGENTS.md
    // A2/G-1: high-stakes action and its audit row in the SAME tx).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      const target = await client.user.findUnique({
        where: { id: targetUserId },
      });
      if (!target) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // 1. Only team-linked staff report to a manager on this surface.
      //    2026-11-07: shared exhaustive rule - ENGINEER included.
      if (!reportsToTeamManager(target.role as Role)) {
        throw new BadRequestException('Only TELECALLER/SALES_EXEC/ENGINEER report to a manager');
      }

      // 1b. ENGINEER targets are admin-class only. Team membership IS the
      //     project-access grant for an engineer (TeamMember -> ProjectTeam
      //     under RLS), so letting a MANAGER use this endpoint would let them
      //     hand out site access - contradicting roles.ts's rule that ENGINEER
      //     provisioning is an admin act (assertCanCreateRole /
      //     assertCanChangeRole). The general outranks() check below would
      //     otherwise pass, because MANAGER (rank 2) outranks ENGINEER (1).
      const isEngineerTarget = target.role === 'ENGINEER';
      if (isEngineerTarget && !isAdminClass(actor.role)) {
        throw new ForbiddenException(
          `${actor.role} cannot change an ENGINEER's team - team membership grants site access, so this is OWNER/ADMIN only`,
        );
      }

      // 2. Hierarchy: actor must strictly outrank the target (mirrors
      //    update()/changeRole() - no self-service).
      if (!outranks(actor.role, target.role as Role)) {
        throw new ForbiddenException(`${actor.role} cannot reassign this user's manager`);
      }

      // 3. Target team must exist, be active, and have a manager -
      //    assigning into an unled team would make "manager" mean nothing.
      //    A soft-deleted team is treated as absent (mirrors
      //    teams.service.reassignMembers' active-team check) rather than
      //    silently accepted.
      const team = await client.team.findUnique({
        where: { id: dto.teamId },
        select: { id: true, name: true, managerId: true, deletedAt: true },
      });
      if (team === null || team.deletedAt !== null) {
        throw new NotFoundException(`Team ${dto.teamId} not found`);
      }
      if (team.managerId === null) {
        throw new BadRequestException(`Team "${team.name}" has no manager assigned yet`);
      }

      // 4. MANAGER scope: only into their own team.
      if (actor.role === 'MANAGER' && team.managerId !== actor.sub) {
        throw new ForbiddenException('Managers can only assign staff into their own team');
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): "assign into this
      // team" means "move them into the chosen team" for TELECALLER/
      // SALES_EXEC - this endpoint models a single-team move for those roles,
      // mirroring reassignMembers()'s move semantics.
      //
      // SCOPED MOVE (2026-09-13, partial-move fix): the delete is scoped to
      // the memberships the ACTOR can actually mutate, and the end state is
      // verified. Previously an unscoped `deleteMany({ userId })` ran, so for
      // a MANAGER every row on a team they do not lead was silently skipped
      // (RLS `USING` does not match an invisible row) while the call still
      // reported success - the "move" became an ADD and the user ended up in
      // two teams.
      const beforeTeamId = await this.resolveDisplayTeamId(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );

      // A MANAGER can only see/delete rows on teams they lead. If the target
      // has no membership in such a team we cannot tell "belongs to no team"
      // from "belongs to ANOTHER manager's team" (RLS hides the latter, which
      // is exactly why this was silent), so fail closed instead of silently
      // adding them alongside an invisible membership.
      const currentMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
      });
      const beforeTeamIds = currentMemberships.map((m) => m.teamId).sort();

      if (isEngineerTarget) {
        // ── ENGINEER: ADDITIVE ────────────────────────────────────────────
        // Never delete. An engineer's whole RLS surface is TeamMember ->
        // ProjectTeam, so removing a membership revokes project access. Adding
        // a second team is how an engineer gets another project, and this
        // endpoint must not be able to take one away.
        if (beforeTeamIds.includes(dto.teamId)) {
          // Fail loudly instead of writing an audit row for a no-op.
          throw new ConflictException(
            `User ${target.id} is already a member of team ${dto.teamId}. Nothing was changed.`,
          );
        }

        await client.teamMember.create({
          data: {
            userId: target.id,
            teamId: dto.teamId,
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });

        // Additive invariant, same transaction: every membership that existed
        // before must still exist, and the destination must now be present.
        // This replaces the move-only "settled to exactly one" assertion -
        // without it the additive branch would be enforced by tests alone.
        const additiveAfter = await client.teamMember.findMany({
          where: { userId: target.id, organizationId: actor.organizationId },
          select: { teamId: true },
        });
        const afterTeamIds = additiveAfter.map((m) => m.teamId);
        const lost = beforeTeamIds.filter((id) => !afterTeamIds.includes(id));
        if (lost.length > 0 || !afterTeamIds.includes(dto.teamId)) {
          throw new ConflictException(
            `Could not add user ${target.id} to team ${dto.teamId} without disturbing their other teams (${lost.join(', ') || 'destination missing'}). No change was applied.`,
          );
        }

        await client.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.assignManager',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            // teamIds (plural) so the ADDED membership is visible - the
            // previous before/after teamId pair could not express "kept both".
            before: { teamIds: beforeTeamIds },
            after: { teamIds: [...afterTeamIds].sort() },
            reason: `engineer added to team by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: target.id,
          email: target.email,
          name: target.name,
          role: target.role,
          // Newest membership wins in resolveDisplayTeamId, so the team just
          // added is the one the response reports.
          teamId: dto.teamId,
        };
      }

      // ── TELECALLER / SALES_EXEC: MOVE (unchanged) ───────────────────────
      // Safe for these roles: their workload comes from lead ownership, not
      // from team membership.
      if (actor.role === 'MANAGER') {
        const managed = await client.team.findMany({
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
          select: { id: true },
        });
        const managedIds = managed.map((t) => t.id);
        const movable = currentMemberships.filter((m) => managedIds.includes(m.teamId));
        if (movable.length === 0) {
          throw new ForbiddenException(
            'This user is not in a team you manage, so you cannot move them. Ask an ADMIN, or use the team roster to add them.',
          );
        }
        // Delete only the rows on teams this manager leads. Being explicit
        // keeps the intent (and the audit) honest rather than relying on RLS
        // to silently narrow an unscoped delete.
        await client.teamMember.deleteMany({
          where: {
            userId: target.id,
            teamId: { in: managedIds },
            organizationId: actor.organizationId,
          },
        });
      } else {
        // ADMIN/OWNER can see and mutate every membership in the ORG, so the
        // full replace is both possible and intended. The org filter is explicit
        // here (T-ORG-EXPLICIT) rather than implied by RLS on TeamMember - the
        // comment above stated the org semantics before the query implemented
        // them.
        await client.teamMember.deleteMany({
          where: { userId: target.id, organizationId: actor.organizationId },
        });
      }

      await client.teamMember.create({
        data: {
          userId: target.id,
          teamId: dto.teamId,
          organizationId: actor.organizationId,
          assignedById: actor.sub,
        },
      });

      // Post-condition, same transaction: after the move the target must hold
      // exactly one membership and it must be the destination. A mismatch
      // means the move did not fully apply, so throw and let the transaction
      // roll back rather than leave the user in two teams. For a MANAGER this
      // asserts over the rows they can see (an unrelated team's membership
      // stays invisible - see the scoped-delete note above).
      const afterMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
      });
      if (afterMemberships.length !== 1 || afterMemberships[0]?.teamId !== dto.teamId) {
        throw new ConflictException(
          `Could not move user ${target.id} cleanly into team ${dto.teamId} - the membership set did not settle to a single team. No change was applied.`,
        );
      }

      // 5. Audit row - same transaction, so a failed audit rolls back the
      //    membership move rather than leaving an unlogged change.
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.assignManager',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { teamId: beforeTeamId },
          after: { teamId: dto.teamId },
          reason: `manager reassigned by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        teamId: dto.teamId,
      };
    });
  }

  /**
   * T-S hardening (2026-09-04, Week 5):
   * POST /api/users/:id/change-password
   *
   * Change a user's password. The actor must be:
   *   - the target user themselves (self-service rotation after the
   *     mustChangePassword gate fires), OR
   *   - ADMIN / OWNER (admin reset, e.g. locked-out operator).
   *
   * Verifies the old password against the credential Account row
   * (scrypt-hashed with the same params the seed uses), then hashes
   * the new password and writes both Account.password and
   * User.mustChangePassword = false. The audit row records who did
   * what and the user being changed (the actor is the writer; the
   * entity is the User row).
   *
   * 404 if the target user doesn't exist; 403 if the actor isn't
   * self/admin/owner; 400 if the old password is wrong.
   */
  async changePassword(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true; mustChangePassword: false }> {
    // 1. Target must exist.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, mustChangePassword: true },
    });
    if (target === null) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 2. Role gate: self OR ADMIN/OWNER.
    const isSelf = target.id === actor.sub;
    const isPrivileged = actor.role === 'ADMIN' || actor.role === 'OWNER';
    if (!isSelf && !isPrivileged) {
      throw new ForbiddenException(
        'You can only change your own password (admin/owner can reset others)',
      );
    }
    // Admin reset: the actor must strictly outrank the target (an ADMIN
    // can't reset the OWNER or another ADMIN), mirroring the role-change
    // hierarchy guard.
    if (!isSelf && !outranks(actor.role, target.role)) {
      throw new ForbiddenException(`You can't reset the password of a ${target.role} user`);
    }
    // Self-service rotation must prove knowledge of the current password.
    // An admin reset of ANOTHER user does not (the admin doesn't know it).
    if (isSelf && (dto.oldPassword === undefined || dto.oldPassword === '')) {
      throw new BadRequestException('Current password is required');
    }

    // 3. Verify the old password against the credential Account row.
    // Account uses (providerId='credential', accountId=user.id) as the
    // better-auth 1.7 sign-in contract (see credentials.ts).
    const account = await this.client.account.findUnique({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: target.id,
        },
      },
      select: { password: true },
    });
    if (account === null) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (isSelf && !verifyPassword(dto.oldPassword as string, account.password)) {
      // 400 (not 401) - this is a request-body validation error from
      // the client's perspective. Same shape better-auth's sign-in uses
      // for wrong-password so a probe can't tell the difference between
      // "no such user" and "wrong password" by status code alone.
      throw new BadRequestException('Current password is incorrect');
    }

    // 4. Hash the new password + flip mustChangePassword. Bare client
    // is correct here - User/Account are auth tables without FORCE
    // RLS (same precedent as create()).
    await this.client.account.update({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: target.id,
        },
      },
      data: {
        password: hashPassword(dto.newPassword),
        issuer: 'local:credential',
      },
    });
    await this.client.user.update({
      where: { id: target.id },
      data: { mustChangePassword: false },
    });

    // 5. Audit row in the actor's RLS context so the AuditLog policy
    // admits the insert (it gates on app.user_id).
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.changePassword',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { mustChangePassword: target.mustChangePassword },
          after: { mustChangePassword: false },
          reason: `password changed by ${actor.email} (${actor.role})`,
        },
      });
    });

    return { ok: true, mustChangePassword: false };
  }

  async list(
    actor: JwtPayload,
    filter: UserFilterDto = { limit: 50, offset: 0 },
  ): Promise<UserListResult> {
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): team scoping
    // resolves EVERY team via Team.managerId (a manager may lead multiple
    // teams) UNION the manager's own TeamMember rows, matching
    // TeamAccessService.getAccessibleTeamIds. OWNER and ADMIN see all. All
    // scopes exclude soft-deleted users. Membership is checked via the
    // TeamMember relation now - User.teamId is gone.
    //
    // One RLS transaction: the Team/ProjectTeam lookups below are FORCE
    // ROW LEVEL SECURITY, so on the bare client a MANAGER's team-scope
    // query returns [] and the where-clause degenerates to
    // `teamId IN ('__none__')` - i.e. an EMPTY user list for a manager who
    // demonstrably has team members. User itself has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      let where: Record<string, unknown>;
      // Multiple optional filters each want `OR` (project scope, search). They
      // are accumulated here and ANDed together at the end, because a plain
      // `where.OR = ...` assignment silently replaces whatever set it before.
      const andClauses: Record<string, unknown>[] = [];
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        // T-USER-PROJECT-SCOPE: this branch used to be `{ deletedAt: null }` with
        // NO tenant filter, so it listed users from EVERY organisation. The org
        // is the outer boundary of visibility - scope it here regardless of what
        // else the caller asked for.
        where = { deletedAt: null, organizationId: actor.organizationId };
      } else if (actor.role === 'MANAGER') {
        const teams = await client.team.findMany({
          // T-ORG-EXPLICIT: scope the team lookup by org too. `Team` is
          // org-scoped, so teamIds were already org-bounded in practice - but
          // relying on that implicitly means an RLS policy change silently turns
          // this into a cross-org read. The org is a top-level key on every
          // branch, never an incidental consequence of a join.
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
        });
        const teamIds = teams.map((t) => t.id);
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          teamMemberships:
            teamIds.length > 0
              ? { some: { teamId: { in: teamIds } } }
              : { some: { teamId: '__none__' } },
        };
      } else {
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          id: actor.sub,
        };
      }

      // T-USER-PROJECT-SCOPE (2026-09-16): narrow to staff of ONE project.
      // INTERSECTION with everything above - it can only ever REDUCE the list, so
      // a manager still sees only their own team and a telecaller still sees only
      // themselves. Source of truth is project STAFFING (ProjectTeam = the
      // project<->team link): members of a staffed team, plus the managers of
      // those teams. The actor's OWN row is always kept so a picker can never
      // hide the current owner from a filter they triggered.
      if (filter.projectId !== undefined) {
        // T-ORG-EXPLICIT: validate the caller-supplied projectId against the
        // actor's org, and fail LOUDLY. `Project`/`ProjectTeam` RLS allow any
        // authenticated role, so RLS does bound this - but it bounds it by
        // returning ZERO rows, which is indistinguishable from "this project has
        // no staff" and therefore reports a cross-org probe as an empty picker.
        // An explicit 403 makes the boundary observable.
        const project = await client.project.findFirst({
          where: {
            id: filter.projectId,
            organizationId: actor.organizationId,
            ...PROJECT_ACTIVE,
          },
          select: { id: true },
        });
        if (project === null) {
          throw new ForbiddenException('Project not found in your organization');
        }

        const projectTeams = await client.projectTeam.findMany({
          where: {
            projectId: filter.projectId,
            organizationId: actor.organizationId,
          },
          select: { teamId: true },
        });
        const staffedTeamIds = projectTeams.map((pt) => pt.teamId);
        const staffedTeams =
          staffedTeamIds.length > 0
            ? await client.team.findMany({
                where: { id: { in: staffedTeamIds }, deletedAt: null },
                select: { managerId: true },
              })
            : [];
        const staffedManagerIds = staffedTeams
          .map((t) => t.managerId)
          .filter((id): id is string => id !== null);

        const projectScope: Record<string, unknown>[] = [];
        if (staffedTeamIds.length > 0) {
          projectScope.push({
            teamMemberships: { some: { teamId: { in: staffedTeamIds } } },
          });
        }
        if (staffedManagerIds.length > 0) {
          projectScope.push({ id: { in: staffedManagerIds } });
        }
        // Always include the actor, so "assign to me" style flows keep working
        // and the current owner is never silently filtered out.
        projectScope.push({ id: actor.sub });

        // NOTE: `OR` is a single key, so it must NOT be re-assigned by the search
        // block later in this method - that would silently drop the project
        // scope. Collected into `andClauses` and combined once, below.
        andClauses.push({ OR: projectScope });
      }

      // Assignee pickers: only users who can take work (not banned).
      // `banned` is nullable, so match false OR null.
      if (filter.availableOnly === true) {
        andClauses.push({ OR: [{ banned: false }, { banned: null }] });
      }

      // Server-driven role filter (autoplan 2026-09-09): the UI's MultiSelect
      // sends ?role=SALES_EXEC,TELECALLER; apply it as a WHERE role IN (...)
      // so filtering works across the whole list, not just the loaded page.
      if (filter.role !== undefined) {
        const roles = Array.isArray(filter.role) ? filter.role : [filter.role];
        where = { ...where, role: { in: roles } };
      }

      // Server-side search (autoplan 2026-09-09): the toolbar search input
      // sends ?search=...; match name OR email case-insensitively so search
      // works across the whole list, not just the loaded page.
      //
      // 2026-11-18: also match `phone`, and match it in BOTH shapes.
      //
      // The column stores digits only (`919876543210`), so a plain `contains`
      // would miss every natural way an operator types a number - "98765
      // 43210", "+91 98765 43210", "098765 43210". The term is normalized
      // through the same helper the write path uses, and the RAW term is kept
      // as a second alternative so a partial digit run still matches mid-string
      // (searching "7654" must not be turned into a full-number parse failure).
      if (filter.search !== undefined && filter.search.length > 0) {
        const phoneTerms = searchPhoneTerms(filter.search);
        andClauses.push({
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' } },
            { email: { contains: filter.search, mode: 'insensitive' } },
            ...phoneTerms.map((term) => ({ phone: { contains: term } })),
          ],
        });
      }

      // Combine every accumulated optional filter with AND.
      if (andClauses.length > 0) {
        where = { ...where, AND: andClauses };
      }

      // Server-side pagination (T-SRVPG, mirrors leads): the DataTable
      // paginates client-side over the loaded page, which is wrong for large
      // sets. The page passes limit/offset and the service applies them in the
      // SQL, returning { rows, total } so the pagination control stays honest.
      const [rows, total] = await Promise.all([
        client.user.findMany({
          where,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            // 2026-11-18: opt-in (see UserFilterDto.includePhone). Excluded by
            // default because this same payload backs six picker surfaces that
            // have no reason to see staff mobiles.
            ...(filter.includePhone === true ? { phone: true } : {}),
            // CUSTOMER rows have no phone of their own; theirs is DERIVED from
            // the lead below. Selecting the pointer here keeps that to one
            // batched read per page instead of a query per row.
            ...(filter.includePhone === true ? { customerLeadId: true } : {}),
            // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): the NEWEST
            // TeamMember row is this row's "display team" for non-managers
            // (resolveDisplayTeamId's rule) - a MANAGER's team is resolved
            // separately below via Team.managerId.
            // 2026-11-07 (D8): was 'asc'; flipped so a newly added membership
            // is visible in the table instead of the first team ever joined.
            // teamId tie-break: identical assignedAt is possible within one
            // transaction (see resolveDisplayTeamId).
            teamMemberships: {
              select: { teamId: true },
              orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
              take: 1,
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: filter.offset,
          take: filter.limit,
        }),
        client.user.count({ where }),
      ]);

      // Resolve MANAGER rows' teams via Team.managerId (batched: fetch every
      // team led by any manager on this page, pick the oldest per manager -
      // matches resolveDisplayTeamId's single-row rule).
      const managerIds = rows.filter((r) => r.role === 'MANAGER').map((r) => r.id);
      const ledTeams =
        managerIds.length > 0
          ? await client.team.findMany({
              where: { managerId: { in: managerIds }, deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, managerId: true },
            })
          : [];
      const ledTeamByManagerId = new Map<string, string>();
      for (const t of ledTeams) {
        if (t.managerId !== null && !ledTeamByManagerId.has(t.managerId)) {
          ledTeamByManagerId.set(t.managerId, t.id);
        }
      }

      const resolvedTeamIds = rows.map(
        (r) =>
          (r.role === 'MANAGER' ? ledTeamByManagerId.get(r.id) : r.teamMemberships[0]?.teamId) ??
          null,
      );

      // Project names for the admin Users table (autoplan 2026-09-12).
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): a user's projects
      // are "whichever projects this user's resolved TEAM is linked to"
      // (ProjectTeam) - ProjectMember (per-user linking) was retired.
      // Batched: fetch ProjectTeam rows for every resolved team id at once.
      const uniqueTeamIds = Array.from(
        new Set(resolvedTeamIds.filter((id): id is string => id !== null)),
      );
      const projectTeams =
        uniqueTeamIds.length > 0
          ? await client.projectTeam.findMany({
              where: { teamId: { in: uniqueTeamIds }, ...PROJECT_TEAM_LIVE },
              select: { teamId: true, project: { select: { name: true } } },
              orderBy: { project: { name: 'asc' } },
            })
          : [];
      const projectNamesByTeamId = new Map<string, string[]>();
      for (const pt of projectTeams) {
        const list = projectNamesByTeamId.get(pt.teamId) ?? [];
        list.push(pt.project.name);
        projectNamesByTeamId.set(pt.teamId, list);
      }

      // "Reports to" (2026-10-08, pluralised 2026-11-07). The per-team
      // single-manager batch that used to live here was replaced by the
      // multi-line builder below, which needs the membership rows anyway (the
      // old code derived teams from `resolvedTeamIds[i]`, i.e. only the DISPLAY
      // team, which is exactly the lossiness this decision fixes).
      //
      // 2026-11-07: shared rule (was an inline MANAGER/ADMIN union).
      const needsOwner = rows.some((r) => reportingTargetFor(r.role as Role) === 'ORG_OWNER');
      const orgOwner = needsOwner ? await findOrgOwner(client, actor.organizationId) : null;

      // ── Multi-line "Reports to" (2026-11-07 product decision) ─────────────
      // A staff member on two teams reports to two managers. The single
      // `reportsTo` collapsed that to the newest team's manager, so an admin
      // had no way to learn the other line existed. Built here with ONE batched
      // membership query for the whole page (not per row) plus ONE team query,
      // so paging 50 users costs the same two round trips as before.
      const reportingLineUserIds = rows
        .filter((r) => reportsToTeamManager(r.role as Role))
        .map((r) => r.id);
      const reportingLinesByUserId = new Map<string, TeamReportingLine[]>();
      if (reportingLineUserIds.length > 0) {
        const membershipRows = await client.teamMember.findMany({
          where: { userId: { in: reportingLineUserIds }, organizationId: actor.organizationId },
          // Same tie-break as resolveDisplayTeamId: `assignedAt` defaults to
          // now(), evaluated once per transaction, so bulk inserts can share a
          // timestamp and a single sort key would flip between reads.
          orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
          select: {
            userId: true,
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
        for (const m of membershipRows) {
          // A soft-deleted team grants no access, so it is not a line to show.
          if (m.team.deletedAt !== null) continue;
          const list = reportingLinesByUserId.get(m.userId) ?? [];
          list.push({ teamId: m.teamId, teamName: m.team.name, manager: m.team.manager });
          reportingLinesByUserId.set(m.userId, list);
        }
      }
      // ORG_OWNER roles get the fixed single line; NONE gets an empty array.
      const ownerLine: TeamReportingLine[] =
        orgOwner === null ? [] : [{ teamId: '', teamName: 'Organisation', manager: orgOwner }];

      // T-ORG-OWNER-ACCESS (2026-09-17): OWNER and ADMIN see EVERY project in
      // the org, not just the (empty) set linked to their team. OWNER/ADMIN
      // carry no team (teamId null -> the team-linked map yields an empty
      // list), yet RLS already grants them the org-wide Project registry, so
      // show the full org project names for admin-class rows.
      const adminRoles = new Set(['OWNER', 'ADMIN']);
      const adminRowIndexes = rows
        .map((r, i) => (adminRoles.has(r.role) ? i : -1))
        .filter((i) => i >= 0);
      // One batched fetch of the org's projects, filtered to the name list we
      // already use for the team-linked rows (same shape, same orderBy).
      let orgProjectNames: string[] = [];
      if (adminRowIndexes.length > 0) {
        const orgRows = await client.project.findMany({
          where: {
            organizationId: actor.organizationId,
            // T-SOFT-DELETE: the admin/owner Projects column is the org
            // registry, so it must match the registry's own filter. Without
            // this a soft-deleted project stayed visible as "1 project"
            // (reported 2026-10-01).
            ...PROJECT_ACTIVE,
          },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        orgProjectNames = orgRows.map((p) => p.name);
      }

      // ── Phone for the admin Users table (2026-11-18) ──────────────────────
      // Opt-in. Staff read their own column; a CUSTOMER has NO phone of their
      // own (the account never stores one), so theirs is DERIVED from the lead
      // they are linked to. One batched lead read per page, not a query per
      // row - same shape as ledTeams above, so paging costs stay unchanged.
      //
      // A customer whose lead is missing reads as null, which the table renders
      // as an em dash. Blank is honest here; inventing a value would not be.
      const phoneByUserId = new Map<string, { phone: string | null; source: 'USER' | 'LEAD' }>();
      if (filter.includePhone === true) {
        const leadIds = rows
          .map((r) => (r.role === 'CUSTOMER' ? (r.customerLeadId ?? null) : null))
          .filter((id): id is string => id !== null);
        const leadPhones =
          leadIds.length > 0
            ? await client.lead.findMany({
                where: { id: { in: leadIds }, organizationId: actor.organizationId },
                select: { id: true, phone: true },
              })
            : [];
        const phoneByLeadId = new Map(leadPhones.map((l) => [l.id, l.phone] as const));
        for (const r of rows) {
          if (r.role === 'CUSTOMER') {
            const leadPhone =
              r.customerLeadId != null ? (phoneByLeadId.get(r.customerLeadId) ?? null) : null;
            phoneByUserId.set(r.id, { phone: leadPhone, source: 'LEAD' });
          } else {
            phoneByUserId.set(r.id, { phone: r.phone ?? null, source: 'USER' });
          }
        }
      }

      return {
        rows: rows.map((r, i) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          role: r.role,
          teamId: resolvedTeamIds[i] ?? null,
          // Only present when includePhone was requested; omitting the keys
          // entirely keeps every other picker's payload byte-identical.
          ...(filter.includePhone === true
            ? {
                phone: phoneByUserId.get(r.id)?.phone ?? null,
                phoneSource: phoneByUserId.get(r.id)?.source,
              }
            : {}),
          // 2026-11-07: exhaustive reporting map. MANAGER/ADMIN -> org OWNER;
          // OWNER/CUSTOMER -> nobody; everyone else -> one line per team.
          reportsTo: (() => {
            const target = reportingTargetFor(r.role as Role);
            if (target === 'NONE') return [];
            if (target === 'ORG_OWNER') return ownerLine;
            return reportingLinesByUserId.get(r.id) ?? [];
          })(),
          // Deprecated single-value companion (one release). The first entry's
          // manager keeps any client still reading the old field working; the
          // new UI reads `reportsTo`.
          reportsToPrimary: (() => {
            const target = reportingTargetFor(r.role as Role);
            if (target === 'NONE') return null;
            if (target === 'ORG_OWNER') return orgOwner;
            return (reportingLinesByUserId.get(r.id) ?? [])[0]?.manager ?? null;
          })(),
          // Admin-class rows expose the full org project set; everyone else
          // reflects the projects linked to their resolved team.
          projects: adminRoles.has(r.role)
            ? orgProjectNames
            : (projectNamesByTeamId.get(resolvedTeamIds[i] ?? '') ?? []),
        })),
        total,
      };
    });
  }

  /**
   * GET /api/users/project/:projectId/sales-execs - who can be assigned to a
   * site visit on this project, for the schedule-visit exec picker.
   *
   * T-VISIT-EXEC-SOURCE (2026-09-16). The ORIGINAL implementation derived the
   * list from lead OWNERSHIP (Lead.projectId + Lead.ownerId, filtered to
   * role=SALES_EXEC). That is wrong for this picker: a project can have an
   * assigned exec who simply does not own any lead yet, and then the picker was
   * empty with no way to schedule a visit at all - reported by the owner against
   * shadhil-metro-heights, which had exactly one such exec.
   *
   * Correct semantics: the exec must be STAFFED ON THE PROJECT. `ProjectTeam`
   * is the project↔team link, so:
   *   - execs on any team linked to this project, plus
   *   - the manager of such a team (a manager can conduct a visit too, and the
   *     create() endpoint already accepts SALES_EXEC-or-higher as an assignee).
   *
   * Scoping:
   *   - ADMIN/OWNER: every project member exec/manager.
   *   - MANAGER: only their own team.
   *   - TELECALLER/SALES_EXEC: empty here. A telecaller's picker is fed by
   *     GET /api/users/team (`teamMembers`) instead - the service-side gate is
   *     unchanged, so this is not a permission widening.
   *
   * Lead ownership is kept as a UNION rather than dropped, so an exec who owns a
   * lead in this project is still offered even if their team is not linked (that
   * is how the previous behaviour earned its place).
   */
  async projectSalesExecs(actor: JwtPayload, projectId: string): Promise<CreatedUser[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER' && actor.role !== 'MANAGER') {
      return [];
    }

    // One RLS transaction: `Team` and `Lead` are both FORCE ROW LEVEL
    // SECURITY. On the bare client a MANAGER's team lookup returned [] and
    // the Lead query was filtered by policies evaluating against unset
    // GUCs, so this picker came back empty for the very managers it exists
    // to serve. `User` has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // T-ORG-EXPLICIT: reject a project outside the actor's org up front.
      // `Project`/`ProjectTeam` RLS allow any authenticated role, and RLS bounds
      // cross-org reads only by returning zero rows - which is indistinguishable
      // from "no execs on this project". Fail loudly instead.
      const project = await client.project.findFirst({
        where: {
          id: projectId,
          organizationId: actor.organizationId,
          ...PROJECT_ACTIVE,
        },
        select: { id: true },
      });
      if (project === null) {
        throw new ForbiddenException('Project not found in your organization');
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13): resolve EVERY team the manager
      // leads (JWT teamId is unreliable for managers).
      let managerTeamIds: string[] | null = null;
      if (actor.role === 'MANAGER') {
        const teams = await client.team.findMany({
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
          select: { id: true },
        });
        managerTeamIds = teams.length > 0 ? teams.map((t) => t.id) : ['__none__'];
      }

      // (a) Teams staffed on this project (ProjectTeam = the project↔team link).
      const projectTeams = await client.projectTeam.findMany({
        where: {
          projectId,
          organizationId: actor.organizationId,
          ...(managerTeamIds !== null ? { teamId: { in: managerTeamIds } } : {}),
        },
        select: { teamId: true },
      });
      const projectTeamIds = projectTeams.map((pt) => pt.teamId);

      // The manager of a project team may conduct a visit (create() accepts
      // SALES_EXEC-or-higher), so they belong in the picker too.
      const projectTeamRows =
        projectTeamIds.length > 0
          ? await client.team.findMany({
              where: {
                id: { in: projectTeamIds },
                deletedAt: null,
                organizationId: actor.organizationId,
              },
              select: { id: true, managerId: true },
            })
          : [];
      const teamManagerIds = projectTeamRows
        .map((t) => t.managerId)
        .filter((id): id is string => id !== null);

      // (b) Execs who actually own a lead in this project - kept as a UNION so
      // the previous behaviour is preserved, not replaced.
      const owners = await client.lead.findMany({
        where: {
          projectId,
          ...LEAD_IN_ACTIVE_PROJECT,
          ...(managerTeamIds !== null ? { teamId: { in: managerTeamIds } } : {}),
        },
        select: { ownerId: true },
        distinct: ['ownerId'],
      });
      const ownerIds = owners.map((o) => o.ownerId);

      // Candidates: staffed via a project team (any member) OR a team manager
      // OR a lead owner. Roles are narrowed below.
      const candidateWhere: Record<string, unknown>[] = [];
      if (projectTeamIds.length > 0) {
        candidateWhere.push({ teamMemberships: { some: { teamId: { in: projectTeamIds } } } });
      }
      if (teamManagerIds.length > 0) {
        candidateWhere.push({ id: { in: teamManagerIds } });
      }
      if (ownerIds.length > 0) {
        candidateWhere.push({ id: { in: ownerIds } });
      }
      if (candidateWhere.length === 0) return [];

      const execs = await client.user.findMany({
        where: {
          OR: candidateWhere,
          // SALES_EXEC or MANAGER: the roles the visit-create endpoint accepts
          // as an assignee (a TELECALLER assignee is rejected server-side, so
          // offering one here would produce a guaranteed 400).
          role: { in: ['SALES_EXEC', 'MANAGER'] },
          deletedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): newest
          // TeamMember row (SALES_EXEC is never a manager, so no
          // Team.managerId branch needed - see resolveDisplayTeamId).
          // 2026-11-07 (D8): was 'asc' - see resolveDisplayTeamId.
          teamMemberships: {
            select: { teamId: true },
            orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      });

      // A MANAGER's own team rows resolve teamId from the team they lead, since
      // a manager has no TeamMember row for it.
      const managerTeamByUser = new Map(
        projectTeamRows
          .filter((t) => t.managerId !== null)
          .map((t) => [t.managerId as string, t.id]),
      );

      return execs.map((e) => ({
        id: e.id,
        email: e.email,
        name: e.name,
        role: e.role,
        teamId: e.teamMemberships[0]?.teamId ?? managerTeamByUser.get(e.id) ?? null,
      }));
    });
  }

  /**
   * GET /api/users/team - the actor's team + manager, for the chat
   * mention picker. Unlike `list` (staff→self only), this returns the
   * whole team so a telecaller can see + mention their manager and
   * teammates. Scoping:
   *   - OWNER/ADMIN: all users (they can mention anyone).
   *   - MANAGER: their own team (resolved via Team.managerId).
   *   - TELECALLER/SALES_EXEC: their team + the team's manager.
   * Returns the same CreatedUser shape as `list`.
   */
  async teamMembers(actor: JwtPayload, projectId?: string): Promise<CreatedUser[]> {
    // One RLS transaction: Team/TeamMember are FORCE ROW LEVEL SECURITY, so
    // the bare client resolved `[]` for the actor's teams and this mention
    // picker returned an empty roster. `User` has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      let where: Record<string, unknown>;
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        if (projectId === undefined) {
          // T-ORG-EXPLICIT: was `{}` - the entire directory, with no org scoping
          // and no soft-delete filter, for an admin/owner's @mention picker.
          where = {
            deletedAt: null,
            organizationId: actor.organizationId,
          };
        } else {
          // T-USER-PROJECT-SCOPE: an ADMIN/OWNER has no natural team, so their
          // mention picker listed the WHOLE directory. When the chat pane passes
          // the active project, offer that project's staff instead: members of a
          // project-staffed team, plus those teams' managers.
          // T-ORG-EXPLICIT: same cross-org guard as `list` - reject another
          // org's project instead of returning a misleadingly empty roster.
          const project = await client.project.findFirst({
            where: {
              id: projectId,
              organizationId: actor.organizationId,
              ...PROJECT_ACTIVE,
            },
            select: { id: true },
          });
          if (project === null) {
            throw new ForbiddenException('Project not found in your organization');
          }
          const staffed = await client.projectTeam.findMany({
            where: { projectId, organizationId: actor.organizationId },
            select: { teamId: true },
          });
          const staffedTeamIdsForFilter = staffed.map((pt) => pt.teamId);
          const staffedTeamsForFilter =
            staffedTeamIdsForFilter.length > 0
              ? await client.team.findMany({
                  where: {
                    id: { in: staffedTeamIdsForFilter },
                    deletedAt: null,
                    organizationId: actor.organizationId,
                  },
                  select: { managerId: true },
                })
              : [];
          const mgrIds = staffedTeamsForFilter
            .map((t) => t.managerId)
            .filter((id): id is string => id !== null);

          const scope: Record<string, unknown>[] = [];
          if (staffedTeamIdsForFilter.length > 0) {
            scope.push({
              teamMemberships: { some: { teamId: { in: staffedTeamIdsForFilter } } },
            });
          }
          if (mgrIds.length > 0) scope.push({ id: { in: mgrIds } });
          // Never hide the caller from their own picker.
          scope.push({ id: actor.sub });

          where = { organizationId: actor.organizationId, OR: scope };
        }
      } else {
        // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolve EVERY
        // team the actor is associated with. Managers link via
        // Team.managerId (a manager may lead multiple teams); ordinary
        // staff link via their own TeamMember rows (User.teamId/the JWT
        // teamId claim are gone - a staff member can now be on multiple
        // teams too, so this resolves ALL of them, not just one).
        let teamIds: string[];
        if (actor.role === 'MANAGER') {
          const teams = await client.team.findMany({
            // T-ORG-EXPLICIT: see `list` - never rely on a join to imply the org.
            where: {
              managerId: actor.sub,
              deletedAt: null,
              organizationId: actor.organizationId,
            },
          });
          teamIds = teams.map((t) => t.id);
        } else {
          const memberships = await client.teamMember.findMany({
            // T-ORG-EXPLICIT: read the denormalized org column directly instead
            // of relying on the org-scoped Team join downstream.
            where: { userId: actor.sub, organizationId: actor.organizationId },
            select: { teamId: true },
          });
          teamIds = memberships.map((m) => m.teamId);
        }
        if (teamIds.length === 0) {
          // No team - the actor can only mention themselves.
          return [];
        }
        // Team members + each team's manager (so staff can loop their
        // manager even though the manager isn't a TeamMember row).
        const teams = await client.team.findMany({
          where: { id: { in: teamIds }, organizationId: actor.organizationId },
          select: { managerId: true },
        });
        const managerIds = Array.from(
          new Set(teams.map((t) => t.managerId).filter((id): id is string => id !== null)),
        );
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          OR: [
            { teamMemberships: { some: { teamId: { in: teamIds } } } },
            { id: { in: managerIds.length > 0 ? managerIds : ['__none__'] } },
          ],
        };
      }

      const users = await client.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          teamMemberships: {
            select: { teamId: true },
            // 2026-11-07 (D8): was 'asc' - newest membership is the display
            // team, matching resolveDisplayTeamId.
            orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
        take: 200,
      });
      // Managers resolve their display teamId via Team.managerId (see
      // resolveDisplayTeamId); everyone else uses their newest TeamMember row.
      const managerRows = users.filter((u) => u.role === 'MANAGER');
      const ledTeams =
        managerRows.length > 0
          ? await client.team.findMany({
              where: { managerId: { in: managerRows.map((u) => u.id) }, deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, managerId: true },
            })
          : [];
      const ledTeamByManagerId = new Map<string, string>();
      for (const t of ledTeams) {
        if (t.managerId !== null && !ledTeamByManagerId.has(t.managerId)) {
          ledTeamByManagerId.set(t.managerId, t.id);
        }
      }
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        teamId:
          (u.role === 'MANAGER' ? ledTeamByManagerId.get(u.id) : u.teamMemberships[0]?.teamId) ??
          null,
      }));
    });
  }
}
