// Leads service - REST surface for the Lead Inbox + state-machine guard.
//
// Scoping (per JWT):
//   - OWNER/ADMIN: all leads (after the model filter the RLS policies allow).
//   - MANAGER: leads where Lead.teamId matches the team they manage
//     (Team.managerId === actor.sub). Same trick users.service.ts uses -
//     the JWT teamId claim is unreliable for managers (seed keeps it null).
//   - TELECALLER/SALES_EXEC: leads where Lead.ownerId === actor.sub.
//
// Write paths (all inside `withRlsContext` so the AuditLog insert
// satisfies its RLS policy AND the actor's team is recorded for any
// future-team-scoped triggers):
//   - create: ManagerAssignmentRule stub - TELECALLER-actor creates land
//     on themselves; ADMIN/OWNER/MANAGER can pass ownerId in the DTO.
//     The full rule engine (Plan §18 T-ARM) is deferred; this stub is the
//     documented interim per DECISION-CHANGELOG.
//   - update: name/email/notes only (mutable fields per api-types/leads.ts).
//   - transition: state-machine guard + Lead.state write + AuditLog row.
//
// Reads use the bare client (the RLS policies on `lead` are owned by
// `shadhil_app` and need session vars set - but `tx.lead.findMany`
// inside withRlsContext works just as well). We use withRlsContext
// consistently for symmetry with the writes, even on reads.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  withRlsContext, rlsContextFrom,
  Prisma,
  type PrismaClient,
  type Role,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreateLeadDto,
  LeadActivity,
  LeadDetail,
  LeadFilterDto,
  LeadStateTransitionDto,
  ReassignLeadDto,
  SetLeadCoOwnerDto,
  UpdateLeadDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAccessService } from '../teams/team-access.service';

import {
  canRoleOwnState,
  canTransition,
} from './leads.state-machine';
import {
  canUserBeAssignedTo,
  type LeadAttributes,
  type ManagerAssignmentRule,
  type ResolverResult,
  type TargetUser,
  type Team,
} from './manager-assignment.engine';

export interface LeadRow {
  id: string;
  name: string;
  phone: string;
  status: string;
  source: string | null;
  ownerName: string | null;
  ownerId: string;
  // autoplan 2026-09-07 (D16): the inbox's overdue-first sort needs the
  // creation timestamp (time-to-first-touch SLA, Decision 0.2). Additive,
  // non-breaking.
  createdAt: string;
  updatedAt: string;
}

/**
 * Richer lead shape returned by `createInTransaction()`. The
 * standard `LeadRow` is the list-page projection (subset of
 * fields). `createInTransaction()` returns the full persisted record
 * so callers (e.g. the WhatsApp convert flow) can use the new
 * lead's `phoneE164` to verify against the contact's phone, the
 * `teamId` for follow-up routing, the `state` for the UI's "what's
 * the new lead's state" hint, and the `createdAt` timestamp.
 */
export interface CreatedLead {
  id: string;
  name: string;
  phone: string;
  phoneE164: string | null;
  state: string;
  source: string | null;
  ownerId: string;
  ownerName: string | null;
  teamId: string;
  createdAt: Date;
  updatedAt: string;
}

/**
 * Result shape returned by `list()`. The page (apps/web/src/app/(app)/leads/page.tsx)
 * reads these exact fields - keep them in sync if you rename.
 *
 * `overdueCount` / `newTodayCount` (T-SRVPG, 2026-09-07): under server
 * pagination only the current page is loaded, so the summary line
 * ("N overdue · M new today") can no longer be computed from the rows
 * in the browser. The service returns the counts for the FULL filtered
 * set (not the page) so the summary stays correct across pages.
 */
export interface LeadListResult {
  rows: LeadRow[];
  total: number;
  overdueCount: number;
  newTodayCount: number;
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    // @Optional() (rule 7h): the notifications dep is best-effort. Existing
    // test factories construct LeadsService with one arg; making this
    // optional keeps them green. In production DI resolves it via the
    // @Global() NotificationsModule.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  // T-TEAM-AUTHORITATIVE (2026-09-13): stateless helper, no DI needed -
  // instantiating directly avoids touching every existing test's
  // `new LeadsService(...)` constructor call.
  private readonly teamAccess = new TeamAccessService();

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Resolve EVERY team a MANAGER leads (T-TEAM-AUTHORITATIVE, 2026-09-13:
   * one manager may now lead multiple teams - Decision Audit Trail #39).
   * Mirrors users.service.ts:list() - the JWT teamId claim is unreliable
   * (seed keeps it null) so we look up Team.managerId via
   * TeamAccessService rather than trusting the JWT. Returns [] for a
   * MANAGER with no team (config error, but we don't 500 on it), and for
   * ADMIN/OWNER (their lane is role-based, not team-based - RLS/service
   * checks for those roles never consult this).
   */
  private async managerTeamIds(
    tx: PrismaClient,
    actor: JwtPayload,
  ): Promise<string[]> {
    if (actor.role !== 'MANAGER') return [];
    return this.teamAccess.getManagedTeamIds(tx as never, actor.sub);
  }

  /**
   * Build the Prisma `where` clause for the Lead list based on the
   * actor's role + the LeadFilterDto. Lives in one place so the role
   * scoping has a single source of truth and a single place to test.
   */
  private async listWhere(
    tx: PrismaClient,
    actor: JwtPayload,
    dto: LeadFilterDto,
  ): Promise<Record<string, unknown>> {
    const where: Record<string, unknown> = {};

    if (dto.state !== undefined) {
      where['state'] = Array.isArray(dto.state)
        ? { in: dto.state }
        : dto.state;
    }
    if (dto.ownerId !== undefined) where['ownerId'] = dto.ownerId;
    if (dto.teamId !== undefined) where['teamId'] = dto.teamId;
    // T-ProjectSwitch: filter by the active project (sidebar switcher
    // navigates via /[projectId]/... and every list page passes the id).
    if (dto.projectId !== undefined) where['projectId'] = dto.projectId;
    if (dto.search !== undefined && dto.search.length > 0) {
      where['OR'] = [
        { name: { contains: dto.search, mode: 'insensitive' } },
        { phone: { contains: dto.search } },
      ];
    }

    // Role scoping AFTER the explicit filters, so admin/owner filters
    // (ownerId, teamId) aren't accidentally narrowed.
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      where['ownerId'] = actor.sub;
    } else if (actor.role === 'MANAGER') {
      const teamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
      // Manager with no team sees nothing - narrow with a sentinel so the
      // `where` is still well-formed.
      where['teamId'] = teamIds.length > 0 ? { in: teamIds } : '__no_team__';
    }
    // OWNER/ADMIN: no narrowing (RLS policies enforce cross-tenant
    // boundaries; role-scoping is the role lane only).

    return where;
  }

  /**
   * Build the SQL `WHERE` conditions for the Lead list, mirroring
   * `listWhere`'s role-scoping exactly. T-SRVPG (2026-09-07): the list
   * query moved to raw SQL because Prisma's typed `orderBy` cannot express
   * the overdue-first ordering (a CASE expression over `state` +
   * `createdAt`). The role-scoping logic is duplicated here (not derived
   * from the Prisma `where` object) because converting a Prisma where
   * object back to SQL is error-prone; keep the two in sync.
   */
  private async listConditions(
    tx: PrismaClient,
    actor: JwtPayload,
    dto: LeadFilterDto,
  ): Promise<Prisma.Sql[]> {
    const conditions: Prisma.Sql[] = [];

    if (dto.state !== undefined) {
      conditions.push(
        Array.isArray(dto.state)
          ? Prisma.sql`"state" IN (${Prisma.join(dto.state)})`
          : Prisma.sql`"state" = ${dto.state}`,
      );
    }
    if (dto.ownerId !== undefined) {
      conditions.push(Prisma.sql`"ownerId" = ${dto.ownerId}`);
    }
    if (dto.teamId !== undefined) {
      conditions.push(Prisma.sql`"teamId" = ${dto.teamId}`);
    }
    if (dto.projectId !== undefined) {
      conditions.push(Prisma.sql`"projectId" = ${dto.projectId}`);
    }
    if (dto.search !== undefined && dto.search.length > 0) {
      conditions.push(
        Prisma.sql`("name" ILIKE ${`%${dto.search}%`} OR "phone" ILIKE ${`%${dto.search}%`})`,
      );
    }

    // Role scoping AFTER the explicit filters (same order as listWhere).
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      conditions.push(Prisma.sql`"ownerId" = ${actor.sub}`);
    } else if (actor.role === 'MANAGER') {
      const teamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
      conditions.push(
        teamIds.length > 0
          ? Prisma.sql`"teamId" IN (${Prisma.join(teamIds)})`
          : Prisma.sql`"teamId" = '__no_team__'`,
      );
    }

    return conditions;
  }

  /**
   * Build the SQL `ORDER BY` clause for the Lead list. Default priority
   * buckets (requested 2026-09-12):
   *   0  OVERDUE   - state NEW AND created >30m ago (past the to-first-touch
   *                  SLA; unanswered NEW that need immediate attention)
   *   1  NEW       - state NEW but still within the 30m window (fresh)
   *   2  everything else
   * Within each bucket, most-recent-first (`createdAt DESC`) so the latest
   * lead in that bucket floats up.
   * When the page passes `sortBy`/`sortDir` (server-side sort, T-SRVPG),
   * that column + direction wins instead. `sortBy` is whitelisted by the
   * DTO enum so it can never inject SQL.
   */
  private sortOrderSql(dto: LeadFilterDto): Prisma.Sql {
    if (dto.sortBy !== undefined) {
      const dir = dto.sortDir === 'asc' ? 'ASC' : 'DESC';
      // sortBy is a z.enum(['updatedAt','createdAt','name']) - safe to
      // interpolate as a column name.
      return Prisma.sql`"${Prisma.raw(dto.sortBy)}" ${Prisma.raw(dir)}`;
    }
    return Prisma.sql`
      (CASE
        WHEN "state"='NEW' AND "createdAt" <= now() - interval '30 minutes' THEN 0
        WHEN "state"='NEW' THEN 1
        ELSE 2
      END) ASC,
      "createdAt" DESC
    `;
  }

  /**
   * GET /api/leads - the Lead Inbox. Returns the page-shaped result the
   * UI expects (rows + total + summary counts). Order: overdue NEW leads
   * first (unanswered >30m), then fresh NEW, then the rest - each bucket
   * most-recent first (`createdAt DESC`) - requested 2026-09-12. When the
   * page passes `sortBy`, that wins. Enforced server-side so pagination
   * returns a consistent order (T-SRVPG).
   */
  async list(actor: JwtPayload, dto: LeadFilterDto): Promise<LeadListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const conditions = await this.listConditions(
          tx as unknown as PrismaClient,
          actor,
          dto,
        );
        const whereSql =
          conditions.length > 0
            ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
            : Prisma.empty;

        const [rows, total, overdueCount, newTodayCount] = await Promise.all([
          tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT "id", "name", "phone", "state", "source", "ownerId",
              "createdAt", "updatedAt",
              (SELECT "name" FROM "User" u WHERE u."id" = "Lead"."ownerId") AS "ownerName"
            FROM "Lead"
            ${whereSql}
            ORDER BY
              ${this.sortOrderSql(dto)}
            LIMIT ${dto.limit} OFFSET ${dto.offset}
          `),
          tx.$queryRaw<Array<{ c: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS c FROM "Lead" ${whereSql}
          `),
          tx.$queryRaw<Array<{ c: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS c FROM "Lead"
            ${conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')} AND` : Prisma.sql`WHERE`}
              "state"='NEW' AND "createdAt" <= now() - interval '30 minutes'
          `),
          tx.$queryRaw<Array<{ c: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS c FROM "Lead"
            ${conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')} AND` : Prisma.sql`WHERE`}
              "state"='NEW' AND "createdAt" >= now() - interval '24 hours'
          `),
        ]);

        return {
          total: Number(total[0]?.c ?? 0),
          overdueCount: Number(overdueCount[0]?.c ?? 0),
          newTodayCount: Number(newTodayCount[0]?.c ?? 0),
          rows: rows.map((r) => ({
            id: r.id as string,
            name: r.name as string,
            phone: r.phone as string,
            status: r.state as string,
            source: (r.source as string | null) ?? null,
            ownerId: r.ownerId as string,
            ownerName: (r.ownerName as string | null) ?? null,
            createdAt: (r.createdAt as Date).toISOString(),
            updatedAt: (r.updatedAt as Date).toISOString(),
          })),
        };
      },
    );
  }

  /**
   * GET /api/leads/badge?projectId= - count of NEW leads the actor can see
   * in the given project. Powers the sidebar "Leads" badge (autoplan
   * 2026-09-09): a lead leaves NEW the moment anyone works it, so the
   * badge naturally clears as leads get attention - no explicit
   * viewed-tracking needed.
   *
   * Role-scoped exactly like the list (TELECALLER/SALES_EXEC own leads,
   * MANAGER team, ADMIN/OWNER all) via the same `listConditions` helper.
   * Project-scoped via the `projectId` filter. Counts ALL NEW leads in the
   * project regardless of age (not just the last 24h).
   */
  async badgeCount(
    actor: JwtPayload,
    projectId: string | undefined,
  ): Promise<{ newLeads: number }> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const conditions = await this.listConditions(
          tx as unknown as PrismaClient,
          actor,
          { projectId } as LeadFilterDto,
        );
        conditions.push(Prisma.sql`"state" = 'NEW'`);
        const whereSql =
          conditions.length > 0
            ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
            : Prisma.empty;

        const [count] = await tx.$queryRaw<Array<{ c: bigint }>>(Prisma.sql`
          SELECT COUNT(*) AS c FROM "Lead" ${whereSql}
        `);
        return { newLeads: Number(count?.c ?? 0) };
      },
    );
  }

  /**
   * GET /api/leads/:id - full lead detail row (Lead Detail page, Wireframe #5).
   *
   * Runs inside withRlsContext so the actor's role/team scoping applies
   * (the same RLS policies that gate the inbox). A lead the actor cannot
   * see, or that does not exist, surfaces as a typed 404 (RLS-silent-zero
   * and missing row are indistinguishable to the caller - both are "not
   * found" for this actor).
   */
  async findOne(actor: JwtPayload, leadId: string): Promise<LeadDetail> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const row = await tx.lead.findUnique({
          where: { id: leadId },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            source: true,
            state: true,
            ownerId: true,
            ownerType: true,
            coOwnerId: true,
            teamId: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { name: true } },
            coOwner: { select: { name: true } },
          },
        });
        if (row === null) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }
        return {
          id: row.id,
          name: row.name,
          phone: row.phone,
          email: row.email,
          source: row.source,
          status: row.state,
          ownerId: row.ownerId,
          ownerName: row.owner?.name ?? null,
          ownerType: row.ownerType,
          coOwnerId: row.coOwnerId,
          coOwnerName: row.coOwner?.name ?? null,
          teamId: row.teamId,
          projectId: row.projectId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * GET /api/leads/:id/activities - the lead's timeline (oldest → newest).
   *
   * Verifies the lead exists (and is visible to the actor) first, then
   * returns the Activity rows with the acting user's name joined in so
   * the UI can render "First call (Asha)" per Wireframe #5. Same RLS
   * scoping as findOne.
   */
  async activities(actor: JwtPayload, leadId: string): Promise<LeadActivity[]> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const lead = await tx.lead.findUnique({
          where: { id: leadId },
          select: { id: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }
        const rows = await tx.activity.findMany({
          where: { leadId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            body: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        });
        return rows.map((a) => ({
          id: a.id,
          type: a.type,
          body: a.body,
          createdAt: a.createdAt.toISOString(),
          userName: a.user?.name ?? null,
        }));
      },
    );
  }

  /**
   * POST /api/leads - create a new lead.
   *
   * Owner assignment runs through the ManagerAssignmentRule engine
   * (manager-assignment.engine.ts). The engine evaluates in this order:
   *   1. Active rules for the team, sorted by (priority ASC,
   *      createdAt ASC) - first matching rule wins.
   *   2. Team.defaultAssigneeId fallback (deferred - column ships in
   *      a future migration; today step 2 is a no-op).
   *   3. Neither matched → unassigned (ownerId=null). The service
   *      is responsible for firing notification trigger #1 to the
   *      team manager (deferred - the notifications module ships
   *      in Phase 5; today the audit log records the unassigned
   *      state).
   *
   * ADMIN/MANAGER targets are rejected by the engine (they don't
   * own leads directly). If the only matching rule points at an
   * ADMIN, the engine falls through to the next rule / fallback /
   * unassigned.
   *
   * Reference: Plan §18 (D2 ratified 2026-08-31, D3 manual-reassign
   * bypass); see T-ARM in the open-tasks tracker.
   */
  async create(actor: JwtPayload, dto: CreateLeadDto): Promise<LeadRow> {
    // Public path: open the RLS transaction ourselves, then run the
    // create logic. Returns LeadRow (the list-page projection).
    const created = await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      (tx) => this._createWithClient(actor, dto, tx as unknown as PrismaClient),
    );
    // Notify the assigned owner that a new lead landed in their queue.
    this.emitBestEffort(created.ownerId, {
      type: 'lead.created',
      title: 'New lead assigned',
      body: `${created.name} was assigned to you.`,
      leadId: created.id,
    });
    return {
      id: created.id,
      name: created.name,
      phone: created.phone,
      status: created.state,
      source: created.source,
      ownerId: created.ownerId,
      ownerName: created.ownerName,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt,
    };
  }

  /**
   * T-E2b follow-up (2026-09-05): richer return + transaction
   * override for the WhatsApp convert flow.
   *
   * Accepts a `clientOverride` so the call can run inside a
   * caller-owned transaction (the convert flow opens a tx
   * with withRlsContext(actor) and needs the Lead insert +
   * WhatsappUnknownContact update to commit atomically).
   *
   * Note: the `clientOverride` is expected to ALREADY have the
   * RLS context set (i.e. it's a tx client from a parent
   * withRlsContext block). The caller is responsible for opening
   * the transaction and setting the GUCs - we don't open a nested
   * transaction here because Prisma 7's pg driver adapter
   * doesn't support `$transaction` on a transaction client.
   *
   * Returns the full `CreatedLead` (phoneE164, state, teamId,
   * createdAt) so the convert flow can render the new Lead's
   * state in the response without a re-query.
   */
  async createInTransaction(
    actor: JwtPayload,
    dto: CreateLeadDto,
    clientOverride: PrismaClient,
  ): Promise<CreatedLead> {
    return this._createWithClient(actor, dto, clientOverride);
  }

  /**
   * Internal helper. Pure async - does NOT open a transaction.
   * Caller must have already set up the RLS context (either by
   * passing the tx client from a parent withRlsContext, or by
   * being the bare prisma client and using the public create()
   * wrapper which opens the tx for you).
   *
   * We pull team/rules/team-default-lookup OUT of the inner
   * transaction (steps 1-4) because those reads are fine on the
   * bare client; the only writes (Lead create + audit log) are
   * inside the inner withRlsContext, which we open here using
   * the supplied `client`.
   *
   * Actually - we run EVERYTHING in one withRlsContext block
   * because the engine's team/rule reads are gated by RLS, and
   * partial reads outside the tx would fail. So if
   * `client` is a tx, opening another tx via `withRlsContext`
   * would nest. To avoid the nesting problem, we accept a
   * `client` that's expected to ALREADY have RLS set, and skip
   * the SET LOCAL by detecting whether the client is the bare
   * one. Concretely: the public create() wraps a fresh
   * withRlsContext, then calls _createWithClient(actor, dto, tx).
   * The tx already has app.user_role=actor.role set; _createWithClient
   * just runs the queries against that tx.
   *
   * To make this work for BOTH the public create() (where we own
   * the tx) and createInTransaction() (where the caller owns the
   * tx), _createWithClient always uses the client as-is. The
   * public create() therefore does a TWO-LEVEL withRlsContext:
   * the outer one sets the GUCs and the inner one is a no-op
   * tx-wrap on the tx client (which IS supported by Prisma 7 if
   * the inner is a savepoint, or - for the pg adapter - might
   * require a workaround).
   *
   * The cleanest path: split this into two helpers - one for the
   * "I own the transaction" case, one for the "I have a tx
   * already" case - and have each open the correct number of
   * transactions.
   */
  private async _createWithClient(
    actor: JwtPayload,
    dto: CreateLeadDto,
    client: PrismaClient,
  ): Promise<CreatedLead> {
    // Steps 1-4: read team + rules (these run inside the tx so the
    // RLS context is active). The engine reads via `client` which
    // is the tx client when called from createInTransaction.
    //
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): `actor.teamId`
    // (the JWT claim) is gone - TELECALLER/SALES_EXEC resolve their team
    // via their own TeamMember rows now, mirroring the MANAGER branch
    // below: `dto.teamId` picks one explicitly (validated against their
    // own memberships - lead_insert_telecaller's RLS policy enforces the
    // same EXISTS(TeamMember) check as a second wall), omitted defaults
    // to their first (oldest-assigned) team.
    let teamId: string | null = null;
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      const memberships = await client.teamMember.findMany({
        where: { userId: actor.sub },
        orderBy: { assignedAt: 'asc' },
        select: { teamId: true },
      });
      const memberTeamIds = memberships.map((m) => m.teamId);
      if (dto.teamId !== undefined) {
        if (!memberTeamIds.includes(dto.teamId)) {
          throw new ForbiddenException(
            'You are not a member of the requested team - cannot create lead there',
          );
        }
        teamId = dto.teamId;
      } else {
        teamId = memberTeamIds[0] ?? null;
      }
      if (teamId === null) {
        throw new ForbiddenException('You are not on any team - cannot create lead');
      }
    } else if (actor.role === 'MANAGER') {
      // T-TEAM-AUTHORITATIVE (2026-09-13): a manager may lead multiple
      // teams. `dto.teamId` lets them pick one explicitly; when omitted,
      // default to the FIRST (oldest) team they manage - deterministic
      // and unchanged behavior for the common single-team-manager case.
      // A team picker in the create-lead UI for multi-team managers is
      // follow-up scope (not part of this cutover).
      const managedTeamIds = await this.managerTeamIds(client, actor);
      if (managedTeamIds.length === 0) {
        throw new ForbiddenException(
          'You do not manage any team - cannot create lead',
        );
      }
      if (dto.teamId !== undefined) {
        if (!managedTeamIds.includes(dto.teamId)) {
          throw new ForbiddenException(
            'You do not manage the requested team - cannot create lead there',
          );
        }
        teamId = dto.teamId;
      } else {
        const team = await client.team.findFirst({
          where: { id: { in: managedTeamIds } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        teamId = team?.id ?? managedTeamIds[0]!;
      }
    }
    if (teamId === null && dto.teamId !== undefined) {
      // ADMIN/OWNER explicit team pick (DESIGN.md §3: "admin-created leads
      // can be assigned to any team").
      const chosen = await client.team.findUnique({
        where: { id: dto.teamId },
        select: { id: true },
      });
      if (chosen === null) {
        throw new BadRequestException(`Team ${dto.teamId} not found`);
      }
      teamId = chosen.id;
    }
    if (teamId === null) {
      // ADMIN/OWNER carry no teamId on the JWT (seed keeps it null), but
      // Lead.teamId is NOT NULL. DESIGN.md §3: "admin-created leads can be
      // assigned to any team." Resolve the DEFAULT team (oldest first -
      // the seeded primary team) so a teamless admin/owner can create a
      // lead; the manager-assignment engine then routes the owner within
      // that team. Mirrors pickDefaultProject() (oldest-first default).
      const defaultTeam = await client.team.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (defaultTeam === null) {
        throw new BadRequestException(
          'No team exists - create a team before creating leads',
        );
      }
      teamId = defaultTeam.id;
    }

    const ruleRows = await client.managerAssignmentRule.findMany({
      where: { teamId, active: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        teamId: true,
        source: true,
        priority: true,
        projectId: true,
        phaseId: true,
        language: true,
        region: true,
        targetUserId: true,
        active: true,
        createdAt: true,
      },
    });
    const rules: ManagerAssignmentRule[] = ruleRows;

    const teamRow = await client.team.findUnique({
      where: { id: teamId },
      select: { id: true, defaultAssigneeId: true },
    });
    const teamForEngine: Team = {
      id: teamId,
      defaultAssigneeId: teamRow?.defaultAssigneeId ?? null,
    };

    const resolveTarget = async (
      userId: string,
    ): Promise<TargetUser | null> => {
      const u = await client.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });
      return u === null ? null : { id: u.id, role: u.role as TargetUser['role'] };
    };

    // Public-leads owner override: when the caller (public-leads service,
    // which validated the id against the org) supplies `assignedOwnerId`,
    // bypass the engine and assign to that user directly. Engine fallback
    // still applies for every other path.
    let ownerId: string;
    let resolution: ResolverResult | null = null;
    if (dto.assignedOwnerId !== undefined) {
      ownerId = dto.assignedOwnerId;
    } else {
      const leadAttrs: LeadAttributes = {
        source: dto.source,
        projectId: dto.projectId ?? null,
      };

      resolution = await this.resolveOwnerFromEngine(
        rules,
        teamForEngine,
        leadAttrs,
        resolveTarget,
        actor.sub,
      );

      ownerId = resolution.userId;
    }

    // Steps 5+: write Lead + audit log. The `client` is already a
    // tx with RLS context set, so we use it directly - no inner
    // withRlsContext wrapper.
    const existing = await client.lead.findUnique({
      where: { phone: dto.phone },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        `Lead with phone ${dto.phone} already exists`,
      );
    }

    const created = await client.lead.create({
      data: {
        name: dto.name,
        phone: dto.phone,
        email:
          dto.email && dto.email.trim().length > 0 ? dto.email : null,
        source: dto.source,
        projectId: dto.projectId ?? null,
        ownerId: ownerId,
        ownerType: this.ownerTypeForRole(actor.role),
        teamId,
        organizationId: actor.organizationId,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        phoneE164: true,
        state: true,
        source: true,
        ownerId: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
        owner: { select: { name: true } },
      },
    });

    const assignmentMetadata =
      resolution === null
        ? { kind: 'forced-override' as const, ownerId }
        : resolution.kind === 'rule'
          ? {
              kind: 'rule' as const,
              ruleId: resolution.ruleId,
              priority: resolution.priority,
            }
          : resolution.kind === 'team-default'
            ? { kind: 'team-default' as const, teamId }
            : { kind: 'fallback' as const, fallbackUserId: resolution.userId };

    await client.auditLog.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        action: 'lead.assigned',
        entityType: 'Lead',
        entityId: created.id,
        after: {
          name: created.name,
          phone: created.phone,
          source: created.source,
          ownerId: created.ownerId,
          teamId,
          createdBy: actor.sub,
          ...assignmentMetadata,
        },
        reason: `lead.create by ${actor.email} (${actor.role})`,
      },
    });

    await client.auditLog.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        action: 'lead.create',
        entityType: 'Lead',
        entityId: created.id,
        after: {
          name: created.name,
          phone: created.phone,
          source: created.source,
          ownerId: created.ownerId,
          teamId,
          createdBy: actor.sub,
        },
        reason: `lead.create by ${actor.email} (${actor.role})`,
      },
    });

    return {
      id: created.id,
      name: created.name,
      phone: created.phone,
      phoneE164: created.phoneE164,
      state: created.state,
      source: created.source,
      ownerId: created.ownerId,
      ownerName: created.owner?.name ?? null,
      teamId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt.toISOString(),
    };
  }
  /**
   * Async wrapper around the engine. The engine itself is sync, but
   * the target resolver hits the DB, so we walk the rules in priority
   * order and call the async resolver until one returns a valid
   * (assignable) target. The wrapper returns the engine's
   * discriminated ResolverResult so the caller can audit which path
   * matched.
   *
   * This mirrors the engine's evaluation logic exactly - kept here
   * so the engine stays pure (no async deps) and the service owns
   * DB I/O.
   */
  private async resolveOwnerFromEngine(
    rules: readonly ManagerAssignmentRule[],
    team: Team,
    lead: LeadAttributes,
    resolveTarget: (userId: string) => Promise<TargetUser | null>,
    fallbackUserId: string,
  ): Promise<ResolverResult> {
    // Sort: priority ASC, then createdAt ASC. The engine does the
    // same sort; we duplicate it here so the resolver walks in the
    // same order the engine would.
    const sorted = [...rules].sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Pass 1: rule chain.
    for (const rule of sorted) {
      if (rule.teamId !== team.id) continue;
      if (!rule.active) continue;
      if (rule.source !== lead.source) continue;
      if (!this.ruleMatchesCriteria(rule, lead)) continue;
      const target = await resolveTarget(rule.targetUserId);
      if (target === null) continue;
      if (!canUserBeAssignedTo(target)) continue;
      return {
        kind: 'rule',
        ruleId: rule.id,
        userId: target.id,
        priority: rule.priority ?? 0,
      };
    }

    // Pass 2: team default.
    const defaultUserId = team.defaultAssigneeId ?? null;
    if (defaultUserId !== null) {
      const target = await resolveTarget(defaultUserId);
      if (target !== null && canUserBeAssignedTo(target)) {
        return { kind: 'team-default', userId: target.id };
      }
      // Default points at ADMIN/MANAGER or deleted user - fall through
      // to the actor fallback rather than risk assigning to the wrong
      // role.
    }

    return { kind: 'fallback', userId: fallbackUserId };
  }

  /** Mirror of the engine's criterion-match logic. */
  private ruleMatchesCriteria(
    rule: ManagerAssignmentRule,
    lead: LeadAttributes,
  ): boolean {
    return (
      this.criterionMatches(rule.projectId, lead.projectId) &&
      this.criterionMatches(rule.phaseId, lead.phaseId) &&
      this.criterionMatches(rule.language, lead.language) &&
      this.criterionMatches(rule.region, lead.region)
    );
  }

  /** Wildcard-or-exact-match: null/undefined/'' on the rule side = match anything. */
  private criterionMatches(
    ruleValue: string | null | undefined,
    leadValue: string | null | undefined,
  ): boolean {
    if (ruleValue === null || ruleValue === undefined || ruleValue === '') {
      return true;
    }
    if (leadValue === null || leadValue === undefined) return false;
    return ruleValue === leadValue;
  }

  /**
   * POST /api/leads/:id/reassign - manual reassign (Plan §18 D2/D3).
   *
   * Reassigns a Lead from its current owner to `targetUserId`,
   * preserving the state machine. Allowed for ADMIN (any team)
   * and MANAGER (same team as the lead only). TELECALLER +
   * SALES_EXEC cannot reassign - they can update their own leads
   * via PATCH but not move them sideways.
   *
   * The target user's role must permit owning the lead at its
   * current state (mirrors the lane rules in the state machine):
   *   - TELECALLER: NEW / CONTACTED / VISIT_REQUESTED /
   *     VISIT_SCHEDULED / RESCHEDULED / NO_SHOW
   *   - SALES_EXEC: VISITED / NEGOTIATION / BOOKING_INITIATED
   *   - MANAGER / ADMIN: any state (including terminal)
   *
   * Implementation per Plan §18 + DESIGN.md §3: everything happens
   * inside one `withRlsContext` transaction so the Lead update, the
   * AuditLog row, and the new ownerType are atomic. The previous
   * co-owner (if any) is NULLed on reassign - co-ownership is a
   * transient state for short handoffs; the new owner takes the
   * lead cleanly.
   *
   * Does NOT fan out reminders or fire SSE events here - those
   * are follow-ups (T-DOC scope, not in this commit). The audit
   * row IS the durable signal a downstream consumer can replay.
   */
  async reassign(
    actor: JwtPayload,
    dto: ReassignLeadDto,
  ): Promise<LeadRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // 1. Fetch the lead WITH its current owner + team so the
        //    role/team checks don't have to be re-issued in tx.
        const existing = await tx.lead.findUnique({
          where: { id: dto.leadId },
          select: {
            id: true,
            ownerId: true,
            ownerType: true,
            teamId: true,
            state: true,
            coOwnerId: true,
            name: true,
            phone: true,
            source: true,
            createdAt: true,
            owner: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // 2. Actor can reassign this lead at all? Same shape as
        //    assertCanEditLead (TELECALLER/SALES_EXEC cannot move
        //    sideways; MANAGER must manage this lead's team; ADMIN/OWNER
        //    always). T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): a
        //    manager may lead multiple teams, checked via the FULL
        //    DB-backed managed-team set (Team.managerId) - the legacy
        //    `actor.teamId` equality fallback is gone (User.teamId no
        //    longer exists).
        const managesLeadTeam = async (teamId: string): Promise<boolean> => {
          if (actor.role !== 'MANAGER') return false;
          const managedTeamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
          return managedTeamIds.includes(teamId);
        };
        if (
          actor.role !== 'ADMIN' &&
          actor.role !== 'OWNER' &&
          !(actor.role === 'MANAGER' && (await managesLeadTeam(existing.teamId)))
        ) {
          throw new ForbiddenException('You cannot reassign this lead');
        }

        // 3. Target user exists + is in the right team? ADMIN can
        //    move to any user; MANAGER must match one of their teams.
        //    T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): "the right
        //    team" is resolved via the target's TeamMember rows now
        //    (User.teamId is gone) - a target can be on multiple teams,
        //    so a MANAGER's check looks for ANY overlap with their
        //    managed-team set, and that overlapping team becomes the
        //    lead's new teamId (below).
        const [target, targetMemberships] = await Promise.all([
          tx.user.findUnique({
            where: { id: dto.targetUserId },
            select: { id: true, role: true, name: true },
          }),
          tx.teamMember.findMany({
            where: { userId: dto.targetUserId },
            orderBy: { assignedAt: 'asc' },
            select: { teamId: true },
          }),
        ]);
        if (target === null) {
          throw new NotFoundException(
            `Target user ${dto.targetUserId} not found`,
          );
        }
        const targetTeamIds = targetMemberships.map((m) => m.teamId);
        let targetTeamId: string | null = targetTeamIds[0] ?? null;
        if (actor.role === 'MANAGER') {
          const managedTeamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
          const overlap = targetTeamIds.find((id) => managedTeamIds.includes(id));
          if (overlap === undefined) {
            throw new ForbiddenException(
              'Manager can only reassign to a user in one of their own teams',
            );
          }
          targetTeamId = overlap;
        }

        // 4. Target user's role can own the lead at its current
        //    state? Mirrors the lane rules in the state machine.
        //    OWNER is treated as ADMIN for this check (OWNER doesn't
        //    have a lead lane - it can own anything).
        if (!canRoleOwnState(existing.state, target.role as Role)) {
          throw new BadRequestException(
            `Target user's role ${target.role} cannot own a lead in state ${existing.state}`,
          );
        }

        // 5. Same-owner reassign is a no-op; return the current row.
        //    We still want the audit row though - the reason is
        //    captured in the body and the operation is logically
        //    a "no-op write" the caller might want to record.
        const newOwnerType = this.ownerTypeForRole(target.role as Role);
        const isNoOp = existing.ownerId === target.id;

        if (isNoOp) {
          return {
            id: existing.id,
            name: existing.name,
            phone: existing.phone,
            status: existing.state,
            source: existing.source,
            ownerId: existing.ownerId,
            // Same-owner reassign: the owner hasn't changed, so
            // existing.owner.name is the right value to return.
            ownerName: existing.owner?.name ?? target.name,
            createdAt: existing.createdAt.toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }

        // 6. Update the lead + the audit row, in one transaction.
        //    coOwnerId is omitted (not set to null) - the Prisma
        //    client treats undefined as "skip this field". We don't
        //    want to write to the column at all in the same-owner
        //    no-op branch above; here, where we ARE writing, we
        //    intentionally preserve the previous coOwnerId value
        //    for now (the plan's "coOwnerId cleanup" is a follow-up
        //    once we have a dedicated coOwner endpoint). (See the
        //    "reassign" TODO below for the cleanup pass.)
        //
        //    teamId: Lead.teamId is NOT NULL. If the target user has
        //    a team, the lead follows them (for a MANAGER this is
        //    specifically the OVERLAPPING team resolved above; for
        //    ADMIN/OWNER, the target's first team). If the target has no
        //    team (rare - only OWNER, in current data), the lead
        //    keeps its existing teamId. ADMIN is the only role that
        //    can assign to a team-less user (MANAGER is gated by
        //    the team-mismatch check above).
        const newTeamId = targetTeamId ?? existing.teamId;
        const updated = await tx.lead.update({
          where: { id: existing.id },
          data: {
            ownerId: target.id,
            ownerType: newOwnerType,
            teamId: newTeamId,
          },
          select: {
            id: true,
            name: true,
            phone: true,
            state: true,
            source: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'lead.reassign',
            entityType: 'Lead',
            entityId: updated.id,
            before: {
              ownerId: existing.ownerId,
              ownerType: existing.ownerType,
              teamId: existing.teamId,
              coOwnerId: existing.coOwnerId,
            },
            after: {
              ownerId: updated.ownerId,
              ownerType: newOwnerType,
              teamId: newTeamId,
              coOwnerId: existing.coOwnerId,
            },
            reason: dto.reason,
          },
        });

        // Notify the new owner that the lead was handed to them.
        this.emitBestEffort(target.id, {
          type: 'lead.reassigned',
          title: 'Lead reassigned to you',
          body: `${updated.name} was assigned to you.`,
          leadId: updated.id,
        });

        return {
          id: updated.id,
          name: updated.name,
          phone: updated.phone,
          status: updated.state,
          source: updated.source,
          ownerId: updated.ownerId,
          ownerName: target.name,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/leads/:id/co-owner - set or clear the lead's co-owner.
   * Mirrors reassign's permission + audit-tx shape.
   *
   *   - MANAGER: same-team co-owner only.
   *   - ADMIN/OWNER: any assignable user (cross-team).
   *   - coOwnerId = null clears the co-owner.
   *   - The co-owner must be an assignable role (TELECALLER/SALES_EXEC/
   *     MANAGER) and cannot be the lead's owner.
   */
  async setCoOwner(
    actor: JwtPayload,
    dto: SetLeadCoOwnerDto,
  ): Promise<LeadRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // 1. Fetch the lead + current owner/team.
        const existing = await tx.lead.findUnique({
          where: { id: dto.leadId },
          select: {
            id: true,
            ownerId: true,
            ownerType: true,
            teamId: true,
            state: true,
            coOwnerId: true,
            name: true,
            phone: true,
            source: true,
            createdAt: true,
            owner: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // 2. Actor can set a co-owner on this lead at all? T-TEAM-
        //    AUTHORITATIVE (2026-09-13 clean cutover): checks membership
        //    in the actor's FULL DB-backed managed-team set (a manager
        //    may lead multiple teams) - the legacy `actor.teamId`
        //    equality fallback is gone (User.teamId no longer exists).
        const managesLeadTeam = async (teamId: string): Promise<boolean> => {
          if (actor.role !== 'MANAGER') return false;
          const managedTeamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
          return managedTeamIds.includes(teamId);
        };
        if (
          actor.role !== 'ADMIN' &&
          actor.role !== 'OWNER' &&
          !(actor.role === 'MANAGER' && (await managesLeadTeam(existing.teamId)))
        ) {
          throw new ForbiddenException(
            'You cannot assign a co-owner to this lead',
          );
        }

        // 3. Resolve + validate the target (or clear).
        let newCoOwnerId: string | null = null;
        if (dto.coOwnerId !== null) {
          const target = await tx.user.findUnique({
            where: { id: dto.coOwnerId },
            select: { id: true, role: true },
          });
          if (target === null) {
            throw new NotFoundException(
              `Co-owner user ${dto.coOwnerId} not found`,
            );
          }
          // MANAGER may only co-own within one of their own teams.
          // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolved via
          // the target's TeamMember rows (User.teamId is gone) - any
          // overlap with the manager's managed-team set qualifies.
          if (actor.role === 'MANAGER') {
            const [managedTeamIds, targetMemberships] = await Promise.all([
              this.managerTeamIds(tx as unknown as PrismaClient, actor),
              tx.teamMember.findMany({
                where: { userId: target.id },
                select: { teamId: true },
              }),
            ]);
            const hasOverlap = targetMemberships.some((m) => managedTeamIds.includes(m.teamId));
            if (!hasOverlap) {
              throw new ForbiddenException(
                'Manager can only assign a co-owner in one of their own teams',
              );
            }
          }
          // Co-owner must be an assignable role (can work the lead). The
          // owner + manager lane both hold here for co-ownership.
          if (!canUserBeAssignedTo(target) && target.role !== 'MANAGER') {
            throw new BadRequestException(
              `User's role ${target.role} cannot be a lead co-owner`,
            );
          }
          // Cannot co-own your own lead.
          if (target.id === existing.ownerId) {
            throw new BadRequestException(
              'The lead owner cannot also be the co-owner',
            );
          }
          newCoOwnerId = target.id;
        }

        // 4. Update + audit in one transaction. A no-op (unchanged
        //    co-owner) is still recorded for the audit trail.
        const isNoOp = existing.coOwnerId === newCoOwnerId;

        const updated = await tx.lead.update({
          where: { id: existing.id },
          data: { coOwnerId: newCoOwnerId },
          select: {
            id: true,
            name: true,
            phone: true,
            state: true,
            source: true,
            ownerId: true,
            coOwnerId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: isNoOp ? 'lead.co_owner.noop' : 'lead.co_owner',
            entityType: 'Lead',
            entityId: updated.id,
            before: { coOwnerId: existing.coOwnerId },
            after: { coOwnerId: updated.coOwnerId },
            reason: dto.reason,
          },
        });

        return {
          id: updated.id,
          name: updated.name,
          phone: updated.phone,
          status: updated.state,
          source: updated.source,
          ownerId: updated.ownerId,
          ownerName: existing.owner?.name ?? null,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/leads/:id - mutable fields only. State transitions go
   * through the dedicated transition endpoint so the state-machine guard
   * always runs.
   */
  async update(
    actor: JwtPayload,
    leadId: string,
    dto: UpdateLeadDto,
  ): Promise<LeadRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.lead.findUnique({
          where: { id: leadId },
          select: {
            id: true,
            ownerId: true,
            coOwnerId: true,
            teamId: true,
            name: true,
            email: true,
            phone: true,
            state: true,
            source: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });
        if (!existing) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }

        // Role lane: staff can only edit their own leads (or ones they
        // co-own); manager can edit any lead in a team they lead; admin/owner
        // can edit any.
        await this.assertCanEditLead(tx as unknown as PrismaClient, actor, existing.ownerId, existing.coOwnerId, existing.teamId);

        const updated = await tx.lead.update({
          where: { id: leadId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.email !== undefined ? { email: dto.email && dto.email.trim().length > 0 ? dto.email : null } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          },
          select: {
            id: true,
            name: true,
            phone: true,
            state: true,
            source: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'lead.update',
            entityType: 'Lead',
            entityId: updated.id,
            before: {
              name: existing.name,
              email: existing.email,
              phone: existing.phone,
            },
            after: {
              name: updated.name,
              email: dto.email,
              phone: updated.phone,
            },
            reason: `lead.update by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: updated.id,
          name: updated.name,
          phone: updated.phone,
          status: updated.state,
          source: updated.source,
          ownerId: updated.ownerId,
          ownerName: updated.owner?.name ?? null,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * POST /api/leads/:id/transition - drive the state machine.
   * Re-reads the lead inside the RLS transaction so the state-machine
   * guard sees the ACTUAL current state, not the client's stale view.
   */
  async transition(
    actor: JwtPayload,
    dto: LeadStateTransitionDto,
  ): Promise<LeadRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.lead.findUnique({
          where: { id: dto.leadId },
          select: {
            id: true,
            ownerId: true,
            teamId: true,
            state: true,
            name: true,
            phone: true,
            source: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });
        if (!existing) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        const verdict = canTransition({
          from: existing.state,
          to: dto.toState,
          role: actor.role as Role,
        });
        if (!verdict.ok) {
          if (verdict.code === 'INVALID_TRANSITION') {
            throw new BadRequestException(
              `Cannot transition lead from ${verdict.from} to ${verdict.to} (no such edge in the state machine)`,
            );
          }
          throw new ForbiddenException(
            `Role ${verdict.role} cannot transition lead from ${verdict.from} to ${verdict.to}`,
          );
        }

        // No-op transition: still record an audit row? No - same-state
        // is genuinely a no-op; skip the write entirely.
        if (verdict.reason === 'SAME_STATE') {
          return {
            id: existing.id,
            name: existing.name,
            phone: existing.phone,
            status: existing.state,
            source: existing.source,
            ownerId: existing.ownerId,
            ownerName: existing.owner?.name ?? null,
            createdAt: existing.createdAt.toISOString(),
            updatedAt: existing.updatedAt.toISOString(),
          };
        }

        const updated = await tx.lead.update({
          where: { id: existing.id },
          data: { state: dto.toState },
          select: {
            id: true,
            name: true,
            phone: true,
            state: true,
            source: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'lead.transition',
            entityType: 'Lead',
            entityId: updated.id,
            before: { state: existing.state },
            after: { state: updated.state },
            reason: dto.reason ?? `state change by ${actor.email} (${actor.role})`,
          },
        });

        // Notify the lead's owner that its state changed (e.g. a visit was
        // booked, a deal moved to negotiation). Skip when the actor IS the
        // owner (they already know - they made the change).
        if (existing.ownerId !== actor.sub) {
          this.emitBestEffort(existing.ownerId, {
            type: 'lead.transition',
            title: 'Lead status changed',
            body: `${updated.name} moved to ${updated.state}.`,
            leadId: updated.id,
          });
        }

        return {
          id: updated.id,
          name: updated.name,
          phone: updated.phone,
          status: updated.state,
          source: updated.source,
          ownerId: updated.ownerId,
          ownerName: updated.owner?.name ?? null,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Delete (autoplan 2026-09-07, D13/D14/D17/D19)
  // -------------------------------------------------------------------------

  /**
   * DELETE /api/leads/:id - hard delete, OWNER/ADMIN only (D14: mirrors the
   * `lead_delete_admin` RLS policy exactly; withRlsContext maps OWNER →
   * ADMIN at the Postgres layer, so both roles pass).
   *
   * Guard semantics (D13/D17):
   *   - WON leads and leads with ANY booking are unrecoverable history:
   *     revenue records (Booking cascades on Lead delete - schema.prisma)
   *     and the customer's chat/visit trail must not vanish. 409 with
   *     what/why/fix copy.
   *   - The guard lives in the deleteMany `where` clause, NOT a
   *     select-then-delete: check-then-act has a TOCTOU window (a
   *     transition or booking create between check and delete would
   *     sail through). One atomic statement; 0 rows deleted means
   *     classify by re-reading INSIDE the same tx.
   *
   * Audit (A2/G-1): the before-snapshot is the ONLY trace of the lead
   * after this runs (AuditLog has no lead FK, so it survives the
   * cascade) - snapshot the full row. Same tx: null any
   * WhatsappUnknownContact.convertedToLeadId pointing here (bare unique
   * string, no FK - cascade never touches it, D19).
   */
  async delete(actor: JwtPayload, leadId: string): Promise<{ id: string }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER') {
      throw new ForbiddenException(
        'Only admins and managers (owner/admin) can delete leads',
      );
    }

    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // Full row first: it becomes the audit before-snapshot AND the
        // 0-rows classifier (was it ever there? was it blocked?).
        const existing = await tx.lead.findUnique({
          where: { id: leadId },
          select: {
            id: true,
            name: true,
            phone: true,
            phoneE164: true,
            email: true,
            source: true,
            state: true,
            ownerId: true,
            ownerType: true,
            coOwnerId: true,
            teamId: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }

        // Atomic guarded delete: only removes the row when it is safe
        // to remove (not WON, no bookings of any status). RLS additionally
        // scopes this to rows the admin can see.
        const deleted = await tx.lead.deleteMany({
          where: {
            id: leadId,
            state: { not: 'WON' },
            bookings: { none: {} },
          },
        });

        if (deleted.count === 0) {
          // The row existed when we read it but the guard refused it -
          // name the blocker for the operator (re-read is same-tx, so
          // the state we report is the state the delete saw).
          const blocker = await tx.lead.findUnique({
            where: { id: leadId },
            select: { state: true, bookings: { select: { id: true } } },
          });
          if (blocker === null) {
            // Vanished between our read and the delete: a concurrent
            // admin won the race. Typed 404 (not P2025-as-500).
            throw new NotFoundException(`Lead ${leadId} not found`);
          }
          if (blocker.state === 'WON') {
            throw new ConflictException(
              'This lead is WON - it cannot be deleted. Close it as LOST instead if the deal fell through.',
            );
          }
          throw new ConflictException(
            'This lead has bookings. Deleting it would erase booking history - cancel the booking or close the lead as LOST instead.',
          );
        }

        // D19: WhatsappUnknownContact.convertedToLeadId is a bare unique
        // string (no FK) - the cascade never nulls it. Same tx keeps the
        // convert-flow accounting consistent with the delete.
        await tx.whatsappUnknownContact.updateMany({
          where: { convertedToLeadId: leadId },
          data: { convertedToLeadId: null },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'lead.delete',
            entityType: 'Lead',
            entityId: leadId,
            // The lead row is GONE after this tx - this JSON snapshot is
            // the only remaining record of what was deleted.
            before: { ...existing },
            reason: `lead.delete by ${actor.email} (${actor.role})`,
          },
        });

        return { id: leadId };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Removed in T-ARM: the role-based stub (ownerId = actor.sub for
   * all roles) is replaced by the ManagerAssignmentRule engine.
   * The engine lives in manager-assignment.engine.ts; the async
   * wrapper in create() above calls it via resolveOwnerFromEngine.
   */

  private ownerTypeForRole(role: Role): 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN' {
    if (role === 'TELECALLER' || role === 'SALES_EXEC' || role === 'MANAGER' || role === 'ADMIN') {
      return role;
    }
    // OWNER creating a lead (rare, only for bootstrapping) - tag as
    // ADMIN so the lead appears in admin queries.
    return 'ADMIN';
  }

  private async assertCanEditLead(
    tx: PrismaClient,
    actor: JwtPayload,
    ownerId: string,
    coOwnerId: string | null | undefined,
    teamId: string,
  ): Promise<void> {
    if (actor.role === 'ADMIN' || actor.role === 'OWNER') return;
    if (actor.role === 'MANAGER') {
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): DB-backed
      // managed-team set (supports a manager leading multiple teams) -
      // the legacy `actor.teamId` equality fallback is gone (User.teamId
      // no longer exists).
      const managedTeamIds = await this.managerTeamIds(tx as unknown as PrismaClient, actor);
      if (managedTeamIds.includes(teamId)) return;
    }
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      // Owner or co-owner of the lead can edit it (option B: co-owner
      // gets full view + work).
      if (actor.sub === ownerId || actor.sub === coOwnerId) return;
    }
    throw new ForbiddenException('You cannot edit this lead');
  }

  /**
   * Best-effort notification emit (rule 7j). Never throws to the caller:
   * a notification failure must not break the lead write path. No-ops when
   * the notifications dep is absent (test harness) or emit throws.
   */
  private emitBestEffort(
    recipientSub: string,
    payload: { type: string; title: string; body: string; leadId?: string },
  ): void {
    if (this.notifications === undefined) return;
    try {
      void this.notifications.emit(recipientSub, payload).catch(() => undefined);
    } catch {
      // swallow - best-effort
    }
  }
}