// Staff invites service (2026-11-20).
//
// ADDITIVE to UsersService.create (the temp-password path), which is NOT
// touched by this feature. An invite provisions the same end state - User +
// credential Account + TeamMember + AuditLog - but the invitee chooses their
// own password, and the User row appears only on acceptance.
//
// Write discipline mirrors UsersService: every write runs inside ONE
// withRlsContext transaction so the business row and its AuditLog commit
// atomically (AGENTS.md A2/G-1). The one exception is the accept path's
// pre-flight lookup, which cannot be fenced - see `accept()` for why.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
// JwtPayload comes from @shadhil/auth (the VERIFIED claims: sub + role +
// organizationId + email). The same-named type in @shadhil/api-types is the
// older output-only shape WITHOUT organizationId, which this service needs on
// every query - importing it from there silently loses the tenant.
import type { JwtPayload } from '@shadhil/auth';
import {
  INVITE_ALREADY_ACCEPTED,
  INVITE_ALREADY_PENDING,
  INVITE_EMAIL_TAKEN,
  INVITE_EXPIRED,
  INVITE_INVALID,
  INVITE_REVOKED,
  INVITE_TTL_DAYS,
  type AcceptInviteDto,
  type CreateInviteDto,
  type CreateInviteResult,
  type InviteFilterDto,
  type InviteListResult,
  type InviteRow,
  type InviteStatus,
  type PublicInvitePreview,
} from '@shadhil/api-types';
import { withRlsContext, type PrismaClient, type Role } from '@shadhil/database';

import {
  CodedBadRequestException,
  CodedConflictException,
  CodedForbiddenException,
  CodedGoneException,
  CodedNotFoundException,
} from '../common/errors/coded-exception';
import { PrismaService } from '../prisma/prisma.module';
import { assertCanCreateRole, isAdminClass } from '../users/roles';
import { upsertCredentialAccount } from '../users/credentials';

import { buildInviteLinks } from './invites.links';
import {
  effectiveStatus,
  generateInviteToken,
  hashInviteToken,
  inviteExpiryFrom,
  looksLikeInviteToken,
} from './invites.tokens';

/** Roles that cannot exist without a team, mirroring UsersService.create. */
const ROLES_REQUIRING_TEAM: readonly Role[] = ['TELECALLER', 'SALES_EXEC', 'ENGINEER'];

/** Roles an invite can never create. */
const ROLES_NOT_INVITABLE: readonly Role[] = ['OWNER', 'CUSTOMER'];

/** The subset of an Invite row this service selects. */
const INVITE_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  teamId: true,
  tokenHash: true,
  status: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, name: true, email: true } },
  team: { select: { id: true, name: true } },
} as const;

type InviteRecord = {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  phone: string;
  role: Role;
  teamId: string | null;
  tokenHash: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  invitedBy: { id: string; name: string; email: string };
  team: { id: string; name: string } | null;
};

/** Row shape returned by the `invite_resolve_token` SECURITY DEFINER function. */
type ResolvedToken = {
  id: string;
  organizationId: string;
  teamId: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  invitedById: string;
  organizationSlug: string;
};

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * The WEB origin an invite link points at.
   *
   * ── WHY THIS IS NOT BETTER_AUTH_URL (bug fixed 2026-11-20) ───────────────
   * The first version derived the link from BETTER_AUTH_URL on the reasoning
   * that it is "the app's public origin". In this project it is not: dev sets
   * `BETTER_AUTH_URL=http://localhost:8080`, which is the API, while
   * `/invite/<token>` is a Next.js route on the web app (:3000). So every
   * generated link pointed at the API and 404'd — reported live as
   * "http://localhost:8080/invite/... is not working".
   *
   * In production the two happen to be split across
   * `crm.shadhilbuilders.in` (web) and `api.crm.shadhilbuilders.in` (API), so
   * the same mistake would have sent every staff member to a dead API host.
   *
   * Resolution order, and each step is deliberate:
   *   1. APP_URL — the explicit, unambiguous answer. Set this in prod.
   *   2. NEXT_PUBLIC_APP_URL — already the canonical web origin in the web
   *      app's env, so reusing it cannot disagree with the client.
   *   3. CORS_ORIGINS' first entry — in dev this is the web origin, so a
   *      developer gets a working link with no extra configuration.
   *   4. BETTER_AUTH_URL, but ONLY when it is not the API port (a fallback
   *      that is wrong in exactly the case this bug was).
   * Failing all four is a configuration error, and is thrown rather than
   * silently emitting a relative link that would land staff on the wrong host.
   */
  private get appUrl(): string {
    const explicit = process.env['APP_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'];
    if (explicit !== undefined && explicit.length > 0) return explicit;

    // CORS_ORIGINS lists the browser origins; the first is the web app.
    const corsFirst = (process.env['CORS_ORIGINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (corsFirst !== undefined) return corsFirst;

    // Last resort: BETTER_AUTH_URL, but not when it points at this API - that
    // is the precise misconfiguration that produced dead links.
    const authUrl = process.env['BETTER_AUTH_URL'];
    const apiPort = process.env['API_PORT'];
    if (authUrl !== undefined && authUrl.length > 0) {
      const isApiOrigin =
        apiPort !== undefined && apiPort.length > 0 && authUrl.includes(`:${apiPort}`);
      if (!isApiOrigin) return authUrl;
    }

    throw new Error(
      'Cannot build an invite link: set APP_URL to the WEB app origin (e.g. ' +
        'http://localhost:3000). BETTER_AUTH_URL points at the API in this ' +
        'environment, and /invite/<token> is a web route.',
    );
  }

  // ── Admin surface ────────────────────────────────────────────────────────

  /**
   * POST /api/invites.
   *
   * Guards mirror UsersService.create so the two provisioning paths can never
   * disagree about who may create whom:
   *   - assertCanCreateRole (hierarchy; ENGINEER/CUSTOMER admin-class only)
   *   - CUSTOMER is refused outright (it needs a customerLeadId this form
   *     cannot collect - POST /api/users remains its home)
   *   - a MANAGER may only target a team they lead
   *   - teamId required for team-bound roles
   *   - one live invite per (org, email), plus a hard stop if that email
   *     already belongs to a user (live OR soft-deleted) in this org
   */
  async create(actor: JwtPayload, dto: CreateInviteDto): Promise<CreateInviteResult> {
    assertCanCreateRole(actor.role, dto.role);

    if (ROLES_NOT_INVITABLE.includes(dto.role)) {
      throw new CodedBadRequestException(
        'INVITE_ROLE_NOT_SUPPORTED',
        dto.role === 'CUSTOMER'
          ? 'A customer login needs a lead to attach to - create it from Add user instead.'
          : 'That role cannot be invited.',
      );
    }

    return withRlsContext(this.client, this.rlsFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      const teamId = await this.resolveInviteTeam(client, actor, dto);

      // The address must not already be a user in this org. Checked for
      // soft-deleted rows too: re-inviting an address that belongs to a
      // disabled account would fail at acceptance with a P2002 the invitee
      // could do nothing about, so the admin is told now instead.
      const existingUser = await client.user.findFirst({
        where: { email: dto.email, organizationId: actor.organizationId },
        select: { id: true, deletedAt: true },
      });
      if (existingUser !== null) {
        throw new CodedConflictException(
          INVITE_EMAIL_TAKEN,
          existingUser.deletedAt === null
            ? 'A user with that email already exists in your organization.'
            : 'That email belongs to a deactivated user. Edit that account instead of sending a new invite.',
        );
      }

      // One live invite per address. The partial unique index would also
      // catch this, but a P2002 gives the operator nothing to act on.
      const liveInvite = await client.invite.findFirst({
        where: {
          organizationId: actor.organizationId,
          email: dto.email,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (liveInvite !== null) {
        throw new CodedConflictException(
          INVITE_ALREADY_PENDING,
          'That person already has a pending invite. Resend it instead of creating a new one.',
        );
      }

      const rawToken = generateInviteToken();
      const created = await client.invite.create({
        data: {
          organizationId: actor.organizationId,
          email: dto.email,
          name: dto.name,
          phone: dto.phone,
          role: dto.role as Role,
          teamId,
          tokenHash: hashInviteToken(rawToken),
          invitedById: actor.sub,
          expiresAt: inviteExpiryFrom(new Date(), INVITE_TTL_DAYS),
        },
        select: INVITE_SELECT,
      });

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'invite.create',
          organizationId: actor.organizationId,
          entityType: 'Invite',
          entityId: created.id,
          after: {
            email: created.email,
            role: created.role,
            teamId: created.teamId,
            // The token itself is NEVER audited - an audit log is readable by
            // every admin and would become a list of live credentials.
            expiresAt: created.expiresAt.toISOString(),
          },
          reason: `invite.create by ${actor.email} (${actor.role})`,
        },
      });

      return this.toResult(client, created, rawToken);
    });
  }

  /**
   * GET /api/invites.
   *
   * Scope: ADMIN/OWNER see the org; a MANAGER sees invites into teams they
   * lead. The status filter is translated in SQL against (status, expiresAt)
   * because EXPIRED is derived - filtering the page in memory would make the
   * pagination total lie.
   */
  async list(actor: JwtPayload, filter: InviteFilterDto): Promise<InviteListResult> {
    return withRlsContext(this.client, this.rlsFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      const now = new Date();

      const where: Record<string, unknown> = { organizationId: actor.organizationId };

      if (!isAdminClass(actor.role)) {
        // MANAGER: only teams they lead. A non-manager staff role reaching
        // this route is not a supported surface, so it sees nothing rather
        // than the org.
        if (actor.role !== 'MANAGER') {
          return { rows: [], total: 0 };
        }
        const led = await client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null, organizationId: actor.organizationId },
          select: { id: true },
        });
        where['teamId'] = { in: led.length > 0 ? led.map((t) => t.id) : ['__none__'] };
      }

      const statusClause = this.statusWhere(filter.status, now);
      if (statusClause !== undefined) Object.assign(where, statusClause);

      const [rows, total] = await Promise.all([
        client.invite.findMany({
          where,
          select: INVITE_SELECT,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          skip: filter.offset,
          take: filter.limit,
        }),
        client.invite.count({ where }),
      ]);

      return { rows: rows.map((r) => this.toRow(r, now)), total };
    });
  }

  /**
   * Translate a requested status list into SQL.
   *
   * EXPIRED and PENDING both live on the SAME stored value ('PENDING'), split
   * by the deadline, so neither can be a plain equality. Everything else is
   * an exact match. A multi-value request is an OR of the per-value clauses.
   */
  private statusWhere(
    statuses: InviteStatus[] | undefined,
    now: Date,
  ): Record<string, unknown> | undefined {
    if (statuses === undefined || statuses.length === 0) return undefined;

    const clauses = statuses.map((status) => {
      if (status === 'EXPIRED') {
        return { status: 'PENDING', expiresAt: { lte: now } };
      }
      if (status === 'PENDING') {
        return { status: 'PENDING', expiresAt: { gt: now } };
      }
      return { status };
    });

    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }

  /**
   * POST /api/invites/:id/resend.
   *
   * Rotates the token (the old link dies immediately) and pushes the expiry
   * out. Same response shape as create so the UI reuses one result panel.
   */
  async resend(actor: JwtPayload, inviteId: string): Promise<CreateInviteResult> {
    return withRlsContext(this.client, this.rlsFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      const invite = await this.loadManageable(client, actor, inviteId);

      const state = effectiveStatus(invite);
      if (state === 'ACCEPTED') {
        throw new CodedConflictException(
          INVITE_ALREADY_ACCEPTED,
          'That invite has already been accepted - there is nothing to resend.',
        );
      }
      if (state === 'REVOKED') {
        throw new CodedConflictException(
          INVITE_REVOKED,
          'That invite was revoked. Send a fresh invite instead.',
        );
      }

      const rawToken = generateInviteToken();
      const updated = await client.invite.update({
        where: { id: invite.id },
        data: {
          // A resend REVIVES an expired invite: the admin's intent is "let
          // them in", so the deadline resets rather than staying in the past.
          tokenHash: hashInviteToken(rawToken),
          expiresAt: inviteExpiryFrom(new Date(), INVITE_TTL_DAYS),
          lastSentAt: new Date(),
          status: 'PENDING',
        },
        select: INVITE_SELECT,
      });

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'invite.resend',
          organizationId: actor.organizationId,
          entityType: 'Invite',
          entityId: invite.id,
          before: { expiresAt: invite.expiresAt.toISOString() },
          after: { expiresAt: updated.expiresAt.toISOString() },
          reason: `invite.resend by ${actor.email} (${actor.role})`,
        },
      });

      return this.toResult(client, updated, rawToken);
    });
  }

  /**
   * POST /api/invites/:id/revoke.
   *
   * Terminal. The link stops working immediately (the token arm requires
   * status = 'PENDING').
   */
  async revoke(actor: JwtPayload, inviteId: string): Promise<InviteRow> {
    return withRlsContext(this.client, this.rlsFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      const invite = await this.loadManageable(client, actor, inviteId);

      const state = effectiveStatus(invite);
      if (state === 'ACCEPTED') {
        throw new CodedConflictException(
          INVITE_ALREADY_ACCEPTED,
          'That invite has already been accepted - the account exists. Remove the user instead.',
        );
      }
      if (state === 'REVOKED') {
        // Idempotent: revoking twice is not an error, it is the same end
        // state. Reporting 409 here would make a double-click look broken.
        return this.toRow(invite, new Date());
      }

      const updated = await client.invite.update({
        where: { id: invite.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.sub },
        select: INVITE_SELECT,
      });

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'invite.revoke',
          organizationId: actor.organizationId,
          entityType: 'Invite',
          entityId: invite.id,
          before: { status: invite.status },
          after: { status: 'REVOKED' },
          reason: `invite.revoke by ${actor.email} (${actor.role})`,
        },
      });

      return this.toRow(updated, new Date());
    });
  }

  // ── Public surface ───────────────────────────────────────────────────────

  /**
   * GET /api/public/invites/:token - what the accept page renders.
   *
   * Unauthenticated. Returns the org/role/team the invitee is joining plus the
   * pinned email and the phone (both already travelled in the message they
   * received). No user ids, no inviter email, no token echo.
   */
  async preview(rawToken: string): Promise<PublicInvitePreview> {
    if (!looksLikeInviteToken(rawToken)) {
      throw new CodedNotFoundException(INVITE_INVALID, 'This invite link is not valid.');
    }
    const resolved = await this.resolveToken(hashInviteToken(rawToken));
    if (resolved === null) {
      throw new CodedNotFoundException(INVITE_INVALID, 'This invite link is not valid.');
    }

    // Terminal states are reported as 410 so the page can render the right
    // card instead of an empty form. The preview still names the org - that is
    // what makes "ask your admin for a new invite" actionable.
    const state = effectiveStatus(resolved);
    if (state === 'EXPIRED') {
      throw new CodedGoneException(INVITE_EXPIRED, 'This invite link has expired.');
    }
    if (state === 'REVOKED') {
      throw new CodedGoneException(INVITE_REVOKED, 'This invite link was revoked.');
    }
    if (state === 'ACCEPTED') {
      throw new CodedGoneException(
        INVITE_ALREADY_ACCEPTED,
        'This invite has already been used. Sign in instead.',
      );
    }

    // Now that the org is known, the display fields are read through the
    // ordinary fenced path. The token-scoped SELECT policy admits exactly
    // this row, so this is still authenticated by the token and no more.
    const invite = await withRlsContext(
      this.client,
      {
        userId: resolved.invitedById,
        role: 'INVITE_ACCEPT',
        organizationId: resolved.organizationId,
        inviteTokenHash: hashInviteToken(rawToken),
        inviteTeamId: resolved.teamId,
      },
      async (tx) => {
        const client = tx as unknown as PrismaClient;
        return client.invite.findFirst({
          where: { id: resolved.id },
          select: {
            ...INVITE_SELECT,
            organization: { select: { name: true, slug: true } },
          },
        });
      },
    );
    if (invite === null) {
      // The fence refused the row we just resolved - a policy bug, not a user
      // error. Fail closed and loudly rather than leaking a partial preview.
      this.logger.error(`invite preview: token policy refused resolved id ${resolved.id}`);
      throw new CodedNotFoundException(INVITE_INVALID, 'This invite link is not valid.');
    }

    return {
      organizationName: invite.organization.name,
      organizationSlug: invite.organization.slug,
      email: invite.email,
      phone: invite.phone,
      name: invite.name,
      role: invite.role,
      teamName: invite.team?.name ?? null,
      invitedByName: invite.invitedBy.name,
      expiresAt: invite.expiresAt.toISOString(),
      status: state,
    };
  }

  /**
   * POST /api/public/invites/:token/accept.
   *
   * TWO PHASES, and the split is the whole security design (see the plan's
   * section 2.5):
   *
   *   Phase 1 - one bare read by unique tokenHash. Unavoidable: the token is
   *   the credential, and both the org and the team are needed before
   *   withRlsContext can run (it rejects an empty organizationId). Returns
   *   ids only.
   *
   *   Phase 2 - everything else inside withRlsContext as INVITE_ACCEPT. The
   *   service RE-READS the invite by hash, and that read is policy-checked
   *   (invite_select_token), so a bug here fails closed instead of leaking.
   *   The claim, the User, the credential, the TeamMember and both audit rows
   *   all commit under enforced RLS.
   */
  async accept(
    rawToken: string,
    dto: AcceptInviteDto,
  ): Promise<{ ok: true; email: string; organizationSlug: string }> {
    if (!looksLikeInviteToken(rawToken)) {
      throw new CodedNotFoundException(INVITE_INVALID, 'This invite link is not valid.');
    }
    const tokenHash = hashInviteToken(rawToken);

    // ── Phase 1 ────────────────────────────────────────────────────────────
    // Resolved through a SECURITY DEFINER function, NOT a bare Prisma read:
    // Invite is FORCE RLS, so the bare client sees ZERO rows (verified live).
    // The function returns ids + status only, and only for a hash the caller
    // already proved they hold.
    const resolved = await this.resolveToken(tokenHash);
    if (resolved === null) {
      throw new CodedNotFoundException(INVITE_INVALID, 'This invite link is not valid.');
    }

    // Reject BEFORE the claim, so an expired invite is never marked ACCEPTED.
    const preState = effectiveStatus(resolved);
    if (preState === 'EXPIRED') {
      throw new CodedGoneException(INVITE_EXPIRED, 'This invite link has expired.');
    }
    if (preState === 'REVOKED') {
      throw new CodedGoneException(INVITE_REVOKED, 'This invite link was revoked.');
    }
    if (preState === 'ACCEPTED') {
      throw new CodedGoneException(
        INVITE_ALREADY_ACCEPTED,
        'This invite has already been used. Sign in instead.',
      );
    }

    // Pre-generated so app.user_id can be set to the user being CREATED
    // before the row exists - AuditLog and TeamMember both reference it, and
    // teammember_write_invite_accept pins "userId" = app.user_id.
    const newUserId = createId();

    // ── Phase 2 ────────────────────────────────────────────────────────────
    return withRlsContext(
      this.client,
      {
        userId: newUserId,
        role: 'INVITE_ACCEPT',
        organizationId: resolved.organizationId,
        inviteTokenHash: tokenHash,
        inviteTeamId: resolved.teamId,
      },
      async (tx) => {
        const client = tx as unknown as PrismaClient;

        // Policy-checked re-read (invite_select_token). If the fence is
        // wrong, this returns null and we stop - it does not silently
        // continue on the phase-1 data.
        const invite = await client.invite.findUnique({
          where: { tokenHash },
          select: INVITE_SELECT,
        });
        if (invite === null) {
          throw new CodedForbiddenException(
            'INVITE_NOT_PERMITTED',
            'This invite link is not valid.',
          );
        }

        // Phone: omitted keeps the invite's number; provided corrects it.
        // The correction is recorded below - a silent rewrite would let an
        // invite be redirected to a different handset with no trace.
        const phoneUsed =
          dto.phone !== undefined && dto.phone !== null ? dto.phone : invite.phone;
        const phoneCorrected = phoneUsed !== invite.phone;

        // A staff phone is unique per org (User_phone_organizationId_key, a
        // partial index). The invite was created before that number was ever
        // used, so a collision is possible - someone joined with it, or the
        // admin corrected the phone to one already taken. Surface it as the
        // same friendly 409 the create form uses instead of a raw P2002 the
        // invitee could do nothing about.
        const phoneOwner = await client.user.findFirst({
          where: {
            organizationId: invite.organizationId,
            phone: phoneUsed,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (phoneOwner !== null) {
          throw new CodedConflictException(
            'PHONE_ALREADY_EXISTS',
            'That phone number already belongs to someone in this organization. Ask your admin to fix the invite.',
          );
        }

        // ORDER MATTERS: the User MUST exist before the claim, because
        // Invite.acceptedByUserId is a real FK and the claim sets it. Writing
        // the claim first failed with `Invite_acceptedByUserId_fkey` (caught
        // live). Both statements share this transaction, so a lost race below
        // rolls the user back out - there is no window where a user exists
        // without a claimed invite.
        const user = await client.user.create({
          data: {
            id: newUserId,
            email: invite.email, // pinned - never from request input
            name: dto.name,
            phone: phoneUsed,
            role: invite.role,
            organizationId: invite.organizationId, // from the invite, never input
            emailVerified: false,
            // The invitee chose this password themselves, so the temporary-
            // password rotation gate does not apply. This is the main
            // practical win over the temp-password path.
            mustChangePassword: false,
          },
          select: { id: true, email: true, name: true, role: true },
        });

        // Claim: PENDING -> ACCEPTED. `count !== 1` means a concurrent accept
        // won the race (or the policy refused the write), so we abort - and
        // because the user create above is in the SAME transaction, that
        // abort removes it. The invite_update_accept policy enforces the same
        // transition, so this check is the friendly error rather than the only
        // guard.
        const claim = await client.invite.updateMany({
          where: { id: invite.id, status: 'PENDING' },
          data: {
            status: 'ACCEPTED',
            acceptedAt: new Date(),
            acceptedByUserId: newUserId,
          },
        });
        if (claim.count !== 1) {
          throw new CodedConflictException(
            INVITE_ALREADY_ACCEPTED,
            'This invite has already been used. Sign in instead.',
          );
        }

        // Same credential writer as UsersService.create / the seed, so the
        // scrypt params can never drift from better-auth's sign-in contract.
        await upsertCredentialAccount(client, user.id, dto.password);

        // Membership: only when the invite named a team. teammember_write_
        // invite_accept pins this to app.invite_team_id, and that GUC is unset
        // when the invite has no team - so writing a row here would be denied
        // anyway. Skipping keeps the intent explicit.
        if (invite.teamId !== null) {
          await client.teamMember.create({
            data: {
              userId: user.id,
              teamId: invite.teamId,
              organizationId: invite.organizationId,
              assignedById: invite.invitedBy.id,
            },
          });
        }

        // Two audit rows, same transaction: the invite's lifecycle and the
        // account creation, so neither can exist without the other.
        await client.auditLog.create({
          data: {
            userId: user.id,
            action: 'invite.accept',
            organizationId: invite.organizationId,
            entityType: 'Invite',
            entityId: invite.id,
            after: {
              acceptedByUserId: user.id,
              // Only when they actually differ - an unconditional pair would
              // train a reader to ignore the field.
              ...(phoneCorrected
                ? { phoneOnInvite: invite.phone, phoneUsed }
                : {}),
            },
            reason: `invite accepted by ${user.email}`,
          },
        });
        await client.auditLog.create({
          data: {
            userId: user.id,
            action: 'user.create',
            organizationId: invite.organizationId,
            entityType: 'User',
            entityId: user.id,
            after: {
              email: user.email,
              role: user.role,
              createdBy: invite.invitedBy.id,
              viaInviteId: invite.id,
            },
            reason: `user created via invite by ${user.email}`,
          },
        });

        return {
          ok: true as const,
          email: user.email,
          organizationSlug: resolved.organizationSlug,
        };
      },
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve a token hash to the ids the fenced path needs - the ONE
   * deliberate hole in this table's RLS.
   *
   * WHY IT CANNOT BE A PRISMA READ: "Invite" is FORCE RLS and every arm
   * requires app.user_org_id, which the unauthenticated accept/preview path
   * does not have yet. A bare `invite.findUnique` therefore returns null even
   * for a valid token (verified live - the bare client sees zero rows). This
   * calls a SECURITY DEFINER function instead, which is the established
   * pattern in this repo (team_member_exists, project_unit_ids).
   *
   * The function is as narrow as the problem: input is the sha256 HASH (never
   * the raw token), output is ids + status + deadline + the org slug. No
   * email, no name, no phone, no token echo. Holding the 256-bit token is what
   * makes it return a row.
   */
  private async resolveToken(tokenHash: string): Promise<ResolvedToken | null> {
    const rows = await this.client.$queryRaw<ResolvedToken[]>`
      SELECT * FROM invite_resolve_token(${tokenHash})
    `;
    return rows[0] ?? null;
  }

  private rlsFrom(actor: JwtPayload) {
    return {
      userId: actor.sub,
      role: actor.role,
      organizationId: actor.organizationId,
    };
  }

  /**
   * Resolve and authorise the invite's target team, mirroring the same three
   * rules UsersService.create applies:
   *   - team-bound roles REQUIRE a team
   *   - a MANAGER may only target a team they lead
   *   - the team must exist, be active, and be in the actor's org
   */
  private async resolveInviteTeam(
    client: PrismaClient,
    actor: JwtPayload,
    dto: CreateInviteDto,
  ): Promise<string | null> {
    const needsTeam = ROLES_REQUIRING_TEAM.includes(dto.role as Role);
    if (needsTeam && dto.teamId === undefined) {
      throw new BadRequestException(
        `teamId is required when inviting a ${dto.role} user`,
      );
    }
    if (dto.teamId === undefined) return null;

    const team = await client.team.findFirst({
      where: { id: dto.teamId, organizationId: actor.organizationId },
      select: { id: true, deletedAt: true, managerId: true, name: true },
    });
    if (team === null || team.deletedAt !== null) {
      throw new NotFoundException(`Team ${dto.teamId} not found`);
    }
    if (actor.role === 'MANAGER' && team.managerId !== actor.sub) {
      throw new ForbiddenException('Managers can only invite staff into their own team');
    }
    return team.id;
  }

  /**
   * Load an invite the actor is allowed to manage, or 404.
   *
   * RLS already narrows this (invite_select_admin / invite_select_manager), so
   * a cross-team manager gets zero rows. The explicit org filter is kept
   * anyway: RLS is the wall, but the service must not depend on it alone for
   * a cross-tenant boundary (T-ORG-EXPLICIT).
   */
  private async loadManageable(
    client: PrismaClient,
    actor: JwtPayload,
    inviteId: string,
  ): Promise<InviteRecord> {
    const invite = await client.invite.findFirst({
      where: { id: inviteId, organizationId: actor.organizationId },
      select: INVITE_SELECT,
    });
    if (invite === null) {
      throw new CodedNotFoundException('INVITE_NOT_FOUND', `Invite ${inviteId} not found`);
    }
    if (actor.role === 'MANAGER') {
      // Belt-and-braces over the policy: a manager acts only on their own
      // team's invites, including team-less invites (which they cannot own).
      if (invite.teamId === null) {
        throw new ForbiddenException('Managers can only manage invites for their own team');
      }
      const led = await client.team.findFirst({
        where: { id: invite.teamId, managerId: actor.sub, deletedAt: null },
        select: { id: true },
      });
      if (led === null) {
        throw new ForbiddenException('Managers can only manage invites for their own team');
      }
    }
    return invite;
  }

  private toRow(invite: InviteRecord, now: Date): InviteRow {
    return {
      id: invite.id,
      email: invite.email,
      name: invite.name,
      phone: invite.phone,
      role: invite.role,
      team: invite.team,
      status: effectiveStatus(invite, now),
      expiresAt: invite.expiresAt.toISOString(),
      invitedBy: invite.invitedBy,
      acceptedAt: invite.acceptedAt?.toISOString() ?? null,
      revokedAt: invite.revokedAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  /** Row + links. The ONLY place a raw token enters a response. */
  private async toResult(
    client: PrismaClient,
    invite: InviteRecord,
    rawToken: string,
  ): Promise<CreateInviteResult> {
    const org = await client.organization.findFirst({
      where: { id: invite.organizationId },
      select: { name: true },
    });
    const links = buildInviteLinks({
      appUrl: this.appUrl,
      rawToken,
      phone: invite.phone,
      name: invite.name,
      organizationName: org?.name ?? 'our team',
    });
      return { invite: this.toRow(invite, new Date()), ...links };
  }
}
