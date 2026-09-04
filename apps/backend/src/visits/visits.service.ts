// Visits service — REST surface for site visits + lead state handoff.
//
// Scoping (per JWT):
//   - OWNER/ADMIN: all visits (RLS policies allow cross-tenant reads).
//   - MANAGER: visits where the parent Lead.teamId matches the team
//     they manage (Team.managerId === actor.sub lookup, same pattern
//     as LeadsService.managerTeamId).
//   - TELECALLER/SALES_EXEC: visits where parent Lead.ownerId === actor.sub.
//
// Write paths (all inside `withRlsContext` so the AuditLog insert
// satisfies its RLS policy AND any future team-scoped triggers fire
// in the actor's context):
//   - create: ownerId defaults to the actor (telecaller schedules).
//   - update outcome: drives the parent lead state via
//     LeadsService.transition() — visits.state-machine guard runs first.
//   - reschedule: closes the old visit (RESCHEDULED) and creates a new
//     one (SCHEDULED).
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
  type VisitStatus,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreateSiteVisitDto,
  RescheduleVisitDto,
  UpdateVisitOutcomeDto,
  VisitFilterDto,
} from '@shadhil/api-types';

import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.module';

import { canTransition } from './visits.state-machine';

/**
 * Wire shape returned by every endpoint. Matches the api-types
 * VisitFilterDto's row contract; the web app already imports this
 * shape in apps/web/src/hooks/queries/crm.ts (useVisits).
 */
export interface VisitRow {
  id: string;
  leadId: string;
  leadName: string;
  scheduledFor: string; // ISO
  userId: string;
  userName: string;
  status: VisitStatus;
  outcome: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface VisitListResult {
  total: number;
  rows: VisitRow[];
}

@Injectable()
export class VisitsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Manager → team lookup, identical to LeadsService.managerTeamId.
   * Mirrored here to avoid a circular module import (LeadsModule
   * doesn't import VisitsModule yet; pulling LeadsService into
   * VisitsModule is one-directional).
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
   * GET /api/visits — role-scoped list with optional filters.
   */
  async list(actor: JwtPayload, dto: VisitFilterDto): Promise<VisitListResult> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const where: Record<string, unknown> = {};

        if (dto.leadId !== undefined) where['leadId'] = dto.leadId;
        if (dto.salesExecId !== undefined) where['userId'] = dto.salesExecId;
        if (dto.status !== undefined) {
          where['status'] = Array.isArray(dto.status)
            ? { in: dto.status }
            : dto.status;
        }
        if (dto.from !== undefined || dto.to !== undefined) {
          where['scheduledFor'] = {
            ...(dto.from !== undefined ? { gte: new Date(dto.from) } : {}),
            ...(dto.to !== undefined ? { lte: new Date(dto.to) } : {}),
          };
        }

        // Role scoping: gate via the parent Lead so RLS policies
        // (which join through Lead) are consistent. For MANAGER we
        // resolve the team via the managerId lookup.
        if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
          where['lead'] = { ownerId: actor.sub };
        } else if (actor.role === 'MANAGER') {
          const teamId = await this.managerTeamId(
            tx as unknown as PrismaClient,
            actor,
          );
          where['lead'] = { teamId: teamId ?? '__no_team__' };
        }

        const [rows, total] = await Promise.all([
          tx.siteVisit.findMany({
            where,
            take: dto.limit,
            skip: dto.offset,
            orderBy: { scheduledFor: 'asc' },
            select: {
              id: true,
              leadId: true,
              scheduledFor: true,
              userId: true,
              status: true,
              outcome: true,
              notes: true,
              updatedAt: true,
              lead: { select: { name: true } },
              user: { select: { name: true } },
            },
          }),
          tx.siteVisit.count({ where }),
        ]);

        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            leadId: r.leadId,
            leadName: r.lead.name,
            scheduledFor: r.scheduledFor.toISOString(),
            userId: r.userId,
            userName: r.user.name,
            status: r.status,
            outcome: r.outcome,
            notes: r.notes,
            updatedAt: r.updatedAt.toISOString(),
          })),
        };
      },
    );
  }

  /**
   * POST /api/visits — schedule a new visit. The lead must exist;
   * RLS policies on SiteVisit gate the write by parent Lead team.
   *
   * The DTO's `scheduledFor` is in the future (CreateSiteVisitDtoSchema
   * enforces this). `salesExecId` is optional — if omitted, the actor
   * is the assigned exec (typical telecaller-schedules flow).
   */
  async create(actor: JwtPayload, dto: CreateSiteVisitDto): Promise<VisitRow> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // Verify the lead exists + RLS-gated read of the parent.
        const lead = await tx.lead.findUnique({
          where: { id: dto.leadId },
          select: { id: true, state: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }
        // Per Plan §3: visit scheduling requires the lead to be in
        // VISIT_REQUESTED or VISIT_SCHEDULED. RESCHEDULED is allowed
        // too — a manager re-opening a no-show can re-schedule.
        const eligibleStates: ReadonlyArray<string> = [
          'VISIT_REQUESTED',
          'VISIT_SCHEDULED',
          'RESCHEDULED',
        ];
        if (!eligibleStates.includes(lead.state)) {
          throw new BadRequestException(
            `Lead state ${lead.state} cannot accept a visit (must be VISIT_REQUESTED, VISIT_SCHEDULED, or RESCHEDULED)`,
          );
        }

        const userId = dto.salesExecId ?? actor.sub;

        // Verify the assigned user exists + has a valid role.
        const assignee = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, name: true },
        });
        if (assignee === null) {
          throw new NotFoundException(`User ${userId} not found`);
        }
        if (
          assignee.role !== 'SALES_EXEC' &&
          assignee.role !== 'MANAGER' &&
          assignee.role !== 'ADMIN' &&
          assignee.role !== 'OWNER'
        ) {
          throw new BadRequestException(
            `Visit assignee must be SALES_EXEC or higher (got ${assignee.role})`,
          );
        }

        const created = await tx.siteVisit.create({
          data: {
            leadId: dto.leadId,
            userId,
            scheduledFor: new Date(dto.scheduledFor),
            status: 'SCHEDULED',
            notes: dto.notes ?? null,
          },
          select: {
            id: true,
            leadId: true,
            scheduledFor: true,
            userId: true,
            status: true,
            outcome: true,
            notes: true,
            updatedAt: true,
            lead: { select: { name: true } },
            user: { select: { name: true } },
          },
        });

        // If the lead is in VISIT_REQUESTED, auto-advance to
        // VISIT_SCHEDULED — scheduling the visit is the action that
        // completes the request.
        if (lead.state === 'VISIT_REQUESTED') {
          await this.leadsService.transition(actor, {
            leadId: dto.leadId,
            toState: 'VISIT_SCHEDULED',
            notes: `Visit scheduled for ${created.scheduledFor.toISOString()}`,
          });
        }

        // Audit the visit creation.
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'visit.create',
            entityType: 'SiteVisit',
            entityId: created.id,
            after: {
              leadId: created.leadId,
              scheduledFor: created.scheduledFor.toISOString(),
              userId: created.userId,
              notes: created.notes,
            },
            reason: `Visit created by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: created.id,
          leadId: created.leadId,
          leadName: created.lead.name,
          scheduledFor: created.scheduledFor.toISOString(),
          userId: created.userId,
          userName: created.user.name,
          status: created.status,
          outcome: created.outcome,
          notes: created.notes,
          updatedAt: created.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/visits/:id — update visit outcome. Drives the parent
   * lead state machine via the VisitsService → LeadsService call:
   *
   *   COMPLETED → Lead.VISITED
   *   NO_SHOW   → Lead stays (visit outcome is informational; the
   *               parent lead doesn't auto-flip on no-show — sales
   *               follow-up decides)
   *   RESCHEDULED → creates a new SiteVisit row (via reschedule())
   *   CANCELLED → Lead.VISIT_SCHEDULED stays (cancel is a state on
   *               the visit, not the lead — lead stays VISIT_REQUESTED
   *               for a re-schedule)
   */
  async updateOutcome(
    actor: JwtPayload,
    visitId: string,
    dto: UpdateVisitOutcomeDto,
  ): Promise<VisitRow> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await tx.siteVisit.findUnique({
          where: { id: visitId },
          select: {
            id: true,
            leadId: true,
            status: true,
            lead: { select: { name: true, state: true } },
            user: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Visit ${visitId} not found`);
        }

        // State-machine guard.
        const guard = canTransition({
          from: existing.status,
          to: dto.outcome,
          role: actor.role,
        });
        if (!guard.ok) {
          if (guard.code === 'ROLE_FORBIDDEN') {
            throw new ForbiddenException(
              `Role ${actor.role} cannot transition visit from ${existing.status} to ${dto.outcome}`,
            );
          }
          throw new BadRequestException(
            `Visit cannot transition from ${existing.status} to ${dto.outcome}`,
          );
        }

        const updated = await tx.siteVisit.update({
          where: { id: visitId },
          data: {
            status: dto.outcome,
            outcome: dto.outcome,
            notes: dto.notes ?? null,
          },
          select: {
            id: true,
            leadId: true,
            scheduledFor: true,
            userId: true,
            status: true,
            outcome: true,
            notes: true,
            updatedAt: true,
            lead: { select: { name: true } },
            user: { select: { name: true } },
          },
        });

        // Drive the parent lead state on COMPLETED.
        if (dto.outcome === 'COMPLETED' && existing.lead.state === 'VISIT_SCHEDULED') {
          await this.leadsService.transition(actor, {
            leadId: existing.leadId,
            toState: 'VISITED',
            notes: dto.notes ?? `Visit completed by ${assigneeName(updated.userId, actor)}`,
          });
        }

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'visit.outcome',
            entityType: 'SiteVisit',
            entityId: updated.id,
            before: { status: existing.status },
            after: { status: updated.status, outcome: updated.outcome },
            reason: `Visit outcome set to ${updated.status} by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: updated.id,
          leadId: updated.leadId,
          leadName: updated.lead.name,
          scheduledFor: updated.scheduledFor.toISOString(),
          userId: updated.userId,
          userName: updated.user.name,
          status: updated.status,
          outcome: updated.outcome,
          notes: updated.notes,
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * POST /api/visits/:id/reschedule — close the old visit (RESCHEDULED)
   * and create a new one (SCHEDULED). Old visit keeps its outcome
   * history; new visit links back via `notes` (no FK column today).
   */
  async reschedule(
    actor: JwtPayload,
    visitId: string,
    dto: RescheduleVisitDto,
  ): Promise<VisitRow> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await tx.siteVisit.findUnique({
          where: { id: visitId },
          select: { id: true, leadId: true, status: true },
        });
        if (existing === null) {
          throw new NotFoundException(`Visit ${visitId} not found`);
        }
        if (existing.status !== 'SCHEDULED' && existing.status !== 'NO_SHOW') {
          throw new BadRequestException(
            `Cannot reschedule a visit in ${existing.status} state (must be SCHEDULED or NO_SHOW)`,
          );
        }

        const userId = dto.salesExecId ?? actor.sub;
        const assignee = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, role: true },
        });
        if (assignee === null) {
          throw new NotFoundException(`User ${userId} not found`);
        }

        // Close the old visit.
        await tx.siteVisit.update({
          where: { id: visitId },
          data: { status: 'RESCHEDULED' },
        });

        // Create the new visit.
        const created = await tx.siteVisit.create({
          data: {
            leadId: existing.leadId,
            userId,
            scheduledFor: new Date(dto.scheduledFor),
            status: 'SCHEDULED',
            notes:
              dto.notes !== undefined && dto.notes.length > 0
                ? dto.notes
                : `Rescheduled from ${visitId}`,
          },
          select: {
            id: true,
            leadId: true,
            scheduledFor: true,
            userId: true,
            status: true,
            outcome: true,
            notes: true,
            updatedAt: true,
            lead: { select: { name: true } },
            user: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'visit.reschedule',
            entityType: 'SiteVisit',
            entityId: created.id,
            before: { fromVisitId: visitId },
            after: {
              leadId: created.leadId,
              scheduledFor: created.scheduledFor.toISOString(),
            },
            reason: `Visit rescheduled by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: created.id,
          leadId: created.leadId,
          leadName: created.lead.name,
          scheduledFor: created.scheduledFor.toISOString(),
          userId: created.userId,
          userName: created.user.name,
          status: created.status,
          outcome: created.outcome,
          notes: created.notes,
          updatedAt: created.updatedAt.toISOString(),
        };
      },
    );
  }
}

function assigneeName(userId: string, actor: JwtPayload): string {
  // Tiny helper for the audit-friendly notes string. Avoids a DB hit
  // on the common path; the audit row carries the full actor identity.
  return userId === actor.sub ? actor.email : userId;
}
