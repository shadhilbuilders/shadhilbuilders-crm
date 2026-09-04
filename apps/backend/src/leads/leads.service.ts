// Leads service — REST surface for the Lead Inbox + state-machine guard.
//
// Scoping (per JWT):
//   - OWNER/ADMIN: all leads (after the model filter the RLS policies allow).
//   - MANAGER: leads where Lead.teamId matches the team they manage
//     (Team.managerId === actor.sub). Same trick users.service.ts uses —
//     the JWT teamId claim is unreliable for managers (seed keeps it null).
//   - TELECALLER/SALES_EXEC: leads where Lead.ownerId === actor.sub.
//
// Write paths (all inside `withRlsContext` so the AuditLog insert
// satisfies its RLS policy AND the actor's team is recorded for any
// future-team-scoped triggers):
//   - create: ManagerAssignmentRule stub — TELECALLER-actor creates land
//     on themselves; ADMIN/OWNER/MANAGER can pass ownerId in the DTO.
//     The full rule engine (Plan §18 T-ARM) is deferred; this stub is the
//     documented interim per DECISION-CHANGELOG.
//   - update: name/email/notes only (mutable fields per api-types/leads.ts).
//   - transition: state-machine guard + Lead.state write + AuditLog row.
//
// Reads use the bare client (the RLS policies on `lead` are owned by
// `shadhil_app` and need session vars set — but `tx.lead.findMany`
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
  UpdateLeadDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';

import {
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
 * Result shape returned by `list()`. The page (apps/web/src/app/(app)/leads/page.tsx)
 * reads these exact fields — keep them in sync if you rename.
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
   * Resolve the team a MANAGER leads. Mirrors users.service.ts:list() —
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
      // Manager with no team sees nothing — narrow with a sentinel so the
      // `where` is still well-formed.
      where['teamId'] = teamId ?? '__no_team__';
    }
    // OWNER/ADMIN: no narrowing (RLS policies enforce cross-tenant
    // boundaries; role-scoping is the role lane only).

    return where;
  }

  /**
   * GET /api/leads — the Lead Inbox. Returns the page-shaped result the
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
   * POST /api/leads — create a new lead.
   *
   * Owner assignment runs through the ManagerAssignmentRule engine
   * (manager-assignment.engine.ts). The engine evaluates in this order:
   *   1. Active rules for the team, sorted by (priority ASC,
   *      createdAt ASC) — first matching rule wins.
   *   2. Team.defaultAssigneeId fallback (deferred — column ships in
   *      a future migration; today step 2 is a no-op).
   *   3. Neither matched → unassigned (ownerId=null). The service
   *      is responsible for firing notification trigger #1 to the
   *      team manager (deferred — the notifications module ships
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
    // 1. Resolve teamId first — we need it for the rule query.
    let teamId: string | null = actor.teamId;
    if (actor.role === 'MANAGER') {
      const team = await this.client.team.findFirst({
        where: { managerId: actor.sub },
        select: { id: true },
      });
      if (!team) {
        throw new ForbiddenException(
          'You do not manage any team — cannot create lead',
        );
      }
      teamId = team.id;
    }
    if (teamId === null) {
      throw new BadRequestException(
        'teamId is required when an ADMIN/OWNER creates a lead (no actor teamId)',
      );
    }

    // 2. Pull active rules for the team. The engine does the
    //    sorting; we just feed it the candidates.
    //    T-ARM-SCHEMA (2026-09-04): the rule model now has priority +
    //    projectId / phaseId / language / region criteria columns.
    const ruleRows = await this.client.managerAssignmentRule.findMany({
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

    // 3. Load the team (for defaultAssigneeId — T-ARM-SCHEMA fallback).
    const teamRow = await this.client.team.findUnique({
      where: { id: teamId },
      select: { id: true, defaultAssigneeId: true },
    });
    const teamForEngine: Team = {
      id: teamId,
      defaultAssigneeId: teamRow?.defaultAssigneeId ?? null,
    };

    // 4. Build a target resolver. We don't pre-fetch every user
    //    (could be many) — the engine short-circuits on first match.
    const resolveTarget = async (
      userId: string,
    ): Promise<TargetUser | null> => {
      const u = await this.client.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });
      return u === null ? null : { id: u.id, role: u.role as TargetUser['role'] };
    };

    // 5. Run the engine. The async wrapper below resolves the
    //    target user(s) lazily — the engine itself stays sync.
    const leadAttrs: LeadAttributes = {
      source: dto.source,
      projectId: dto.projectId ?? null,
      // phaseId / language / region are not on LeadAttributes today;
      // the engine treats the absence as null → wildcard for any
      // rule criterion that isn't set.
    };

    const resolution = await this.resolveOwnerFromEngine(
      rules,
      teamForEngine,
      leadAttrs,
      resolveTarget,
      actor.sub,
    );

    // ownerId from the engine's result. The fallback (actor.sub) is
    // already embedded in the discriminated union so the service
    // doesn't need a `?? actor.sub` here.
    const ownerId = resolution.userId;

    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // Phone uniqueness is enforced by Prisma; surface a friendly 409
        // instead of a 500 by pre-checking.
        const existing = await tx.lead.findUnique({
          where: { phone: dto.phone },
          select: { id: true },
        });
        if (existing) {
          throw new BadRequestException(
            `Lead with phone ${dto.phone} already exists`,
          );
        }

        const created = await tx.lead.create({
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
            state: true,
            source: true,
            ownerId: true,
            updatedAt: true,
            owner: { select: { name: true } },
          },
        });

        // Audit the routing decision. The `metadata` shape records
        // exactly which path matched so future debugging (and the
        // CRM analytics dashboard) can attribute every assignment.
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

        await tx.auditLog.create({
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

        // lead.create audit (matches prior shape — keeps the
        // timeline/back-compat intact for the existing surface).
        await tx.auditLog.create({
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
          status: created.state,
          source: created.source,
          ownerId: created.ownerId,
          ownerName: created.owner?.name ?? null,
          updatedAt: created.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * Async wrapper around the engine. The engine itself is sync, but
   * the target resolver hits the DB, so we walk the rules in priority
   * order and call the async resolver until one returns a valid
   * (assignable) target. The wrapper returns the engine's
   * discriminated ResolverResult so the caller can audit which path
   * matched.
   *
   * This mirrors the engine's evaluation logic exactly — kept here
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
      if (!ruleMatchesCriteria(rule, lead)) continue;
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
      // Default points at ADMIN/MANAGER or deleted user — fall through
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
   * PATCH /api/leads/:id — mutable fields only. State transitions go
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
   * POST /api/leads/:id/transition — drive the state machine.
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

        // No-op transition: still record an audit row? No — same-state
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
    // OWNER creating a lead (rare, only for bootstrapping) — tag as
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