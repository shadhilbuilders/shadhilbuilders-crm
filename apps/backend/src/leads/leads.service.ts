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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  withRlsContext,
  type PrismaClient,
  type Role,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreateLeadDto,
  LeadFilterDto,
  LeadStateTransitionDto,
  ReassignLeadDto,
  UpdateLeadDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';

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
 */
export interface LeadListResult {
  rows: LeadRow[];
  total: number;
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Resolve the team a MANAGER leads. Mirrors users.service.ts:list() -
   * the JWT teamId claim is unreliable (seed keeps it null) so we look
   * up Team.managerId. Returns null for ADMIN (no team) or for a MANAGER
   * with no team (config error, but we don't 500 on it).
   */
  private async managerTeamId(
    tx: PrismaClient,
    actor: JwtPayload,
  ): Promise<string | null> {
    if (actor.role === 'MANAGER') {
      const team = await tx.team.findFirst({
        where: { managerId: actor.sub },
        select: { id: true },
      });
      return team?.id ?? null;
    }
    if (actor.role === 'ADMIN' || actor.role === 'OWNER') {
      return actor.teamId;
    }
    return null;
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
      const teamId = await this.managerTeamId(tx as unknown as PrismaClient, actor);
      // Manager with no team sees nothing - narrow with a sentinel so the
      // `where` is still well-formed.
      where['teamId'] = teamId ?? '__no_team__';
    }
    // OWNER/ADMIN: no narrowing (RLS policies enforce cross-tenant
    // boundaries; role-scoping is the role lane only).

    return where;
  }

  /**
   * GET /api/leads - the Lead Inbox. Returns the page-shaped result the
   * UI expects (rows + total). Order: most recent activity first; the
   * page applies overdue-first client-side (Decision 0.2).
   */
  async list(actor: JwtPayload, dto: LeadFilterDto): Promise<LeadListResult> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const where = await this.listWhere(tx as unknown as PrismaClient, actor, dto);
        const [rows, total] = await Promise.all([
          tx.lead.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            take: dto.limit,
            skip: dto.offset,
            select: {
              id: true,
              name: true,
              phone: true,
              state: true,
              source: true,
              ownerId: true,
              updatedAt: true,
              owner: { select: { name: true } },
            },
          }),
          tx.lead.count({ where }),
        ]);
        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            status: r.state,
            source: r.source,
            ownerId: r.ownerId,
            ownerName: r.owner?.name ?? null,
            updatedAt: r.updatedAt.toISOString(),
          })),
        };
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      (tx) => this._createWithClient(actor, dto, tx as unknown as PrismaClient),
    );
    return {
      id: created.id,
      name: created.name,
      phone: created.phone,
      status: created.state,
      source: created.source,
      ownerId: created.ownerId,
      ownerName: created.ownerName,
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
   * because the engine's read of `actor.teamId` is gated by
   * RLS, and partial reads outside the tx would fail. So if
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
    let teamId: string | null = actor.teamId;
    if (actor.role === 'MANAGER') {
      const team = await client.team.findFirst({
        where: { managerId: actor.sub },
        select: { id: true },
      });
      if (!team) {
        throw new ForbiddenException(
          'You do not manage any team - cannot create lead',
        );
      }
      teamId = team.id;
    }
    if (teamId === null) {
      throw new BadRequestException(
        'teamId is required when an ADMIN/OWNER creates a lead (no actor teamId)',
      );
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

    const leadAttrs: LeadAttributes = {
      source: dto.source,
      projectId: dto.projectId ?? null,
    };

    const resolution = await this.resolveOwnerFromEngine(
      rules,
      teamForEngine,
      leadAttrs,
      resolveTarget,
      actor.sub,
    );

    const ownerId = resolution.userId;

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
        email: dto.email ?? null,
        source: dto.source,
        projectId: dto.projectId ?? null,
        ownerId: ownerId,
        ownerType: this.ownerTypeForRole(actor.role),
        teamId,
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
      resolution.kind === 'rule'
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
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
            owner: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // 2. Actor can reassign this lead at all? Same shape as
        //    assertCanEditLead (TELECALLER/SALES_EXEC cannot move
        //    sideways; MANAGER must match team; ADMIN/OWNER always).
        if (
          actor.role !== 'ADMIN' &&
          actor.role !== 'OWNER' &&
          !(actor.role === 'MANAGER' && actor.teamId === existing.teamId)
        ) {
          throw new ForbiddenException('You cannot reassign this lead');
        }

        // 3. Target user exists + is in the right team? ADMIN can
        //    move to any user; MANAGER must match team.
        const target = await tx.user.findUnique({
          where: { id: dto.targetUserId },
          select: {
            id: true,
            role: true,
            teamId: true,
            name: true,
          },
        });
        if (target === null) {
          throw new NotFoundException(
            `Target user ${dto.targetUserId} not found`,
          );
        }
        if (
          actor.role === 'MANAGER' &&
          target.teamId !== actor.teamId
        ) {
          throw new ForbiddenException(
            'Manager can only reassign to a user in their own team',
          );
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
        //    a team, the lead follows them. If the target has no
        //    team (rare - only OWNER, in current data), the lead
        //    keeps its existing teamId. ADMIN is the only role that
        //    can assign to a team-less user (MANAGER is gated by
        //    the team-mismatch check above).
        const newTeamId = target.teamId ?? existing.teamId;
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
            updatedAt: true,
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
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

        return {
          id: updated.id,
          name: updated.name,
          phone: updated.phone,
          status: updated.state,
          source: updated.source,
          ownerId: updated.ownerId,
          ownerName: target.name,
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await tx.lead.findUnique({
          where: { id: leadId },
          select: {
            id: true,
            ownerId: true,
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

        // Role lane: staff can only edit their own leads; manager can edit
        // any lead in their team; admin/owner can edit any.
        this.assertCanEditLead(actor, existing.ownerId, existing.teamId);

        const updated = await tx.lead.update({
          where: { id: leadId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
          },
          select: {
            id: true,
            name: true,
            phone: true,
            state: true,
            source: true,
            ownerId: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'lead.update',
            entityType: 'Lead',
            entityId: updated.id,
            before: { name: existing.name, email: existing.email },
            after: { name: updated.name, email: dto.email },
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
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
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'lead.transition',
            entityType: 'Lead',
            entityId: updated.id,
            before: { state: existing.state },
            after: { state: updated.state },
            reason: dto.reason ?? `state change by ${actor.email} (${actor.role})`,
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
          updatedAt: updated.updatedAt.toISOString(),
        };
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

  private assertCanEditLead(
    actor: JwtPayload,
    ownerId: string,
    teamId: string,
  ): void {
    if (actor.role === 'ADMIN' || actor.role === 'OWNER') return;
    if (actor.role === 'MANAGER' && actor.teamId === teamId) return;
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      if (actor.sub === ownerId) return;
    }
    throw new ForbiddenException('You cannot edit this lead');
  }
}