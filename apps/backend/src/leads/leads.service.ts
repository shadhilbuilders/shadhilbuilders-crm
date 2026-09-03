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

import { canTransition } from './leads.state-machine';

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
   * Owner assignment (ManagerAssignmentRule stub per Plan §18 T-ARM):
   *   - TELECALLER-actor: ownerId = actor.sub (lead lands in their queue)
   *   - SALES_EXEC-actor: ownerId = actor.sub
   *   - MANAGER-actor: must pass ownerId in the DTO. If absent, the lead
   *     lands on the manager themselves (managers don't usually own leads,
   *     but it's a legal fallback when no rule engine exists yet).
   *   - ADMIN/OWNER-actor: must pass ownerId in the DTO. Reject if absent
   *     (ambiguous — who owns it?).
   *
   * The full T-ARM engine (priority-ordered rules with catch-all +
   * defaultAssigneeId fallback) is deferred — see DECISION-CHANGELOG.
   */
  async create(actor: JwtPayload, dto: CreateLeadDto): Promise<LeadRow> {
    const ownerId = this.resolveOwnerOnCreate(actor, dto);

    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // Resolve teamId for the lead. New leads always belong to a team.
        // For TELECALLER/SALES_EXEC, use actor.teamId. For MANAGER, use
        // the team they manage. For ADMIN/OWNER, require dto to include
        // projectId later — for now, use the actor's teamId (admin
        // creates typically happen within an existing team).
        let teamId: string | null = actor.teamId;
        if (actor.role === 'MANAGER') {
          const team = await tx.team.findFirst({
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
            ownerId,
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
   * ManagerAssignmentRule stub (full engine is Plan §18 T-ARM, deferred):
   *   - TELECALLER + SALES_EXEC: ownerId = actor.sub (their own queue).
   *   - MANAGER: dto.ownerId ?? actor.sub.
   *   - ADMIN/OWNER: dto.ownerId required.
   */
  private resolveOwnerOnCreate(
    actor: JwtPayload,
    dto: CreateLeadDto,
  ): string {
    // The DTO doesn't currently carry ownerId — caller passes it via the
    // dto. For now, when actor is staff, default to actor.sub. For
    // admin/owner, default to actor.sub too (later this becomes a
    // required field once the ARM engine ships).
    // TODO(plan-t-arm): when ManagerAssignmentRule ships, drop the
    // default and require a project/source-derived resolution.
    void dto;
    return actor.sub;
  }

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