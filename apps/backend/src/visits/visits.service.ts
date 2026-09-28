// Visits service - REST surface for site visits + lead state handoff.
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
//     LeadsService.transition() - visits.state-machine guard runs first.
//   - reschedule: closes the old visit (RESCHEDULED) and creates a new
//     one (SCHEDULED).
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
// T-VISIT-CLOSE (2026-09-28): the shared "is this lead finished?" predicate.
// Same source as the cascade that cancels open visits, so the guard here and the
// cascade in leads/bookings cannot disagree about what "settled" means.
import { isTerminalLeadState } from '@shadhil/api-types';

import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAccessService } from '../teams/team-access.service';

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
  /**
   * T-VISIT-OWNER-LABEL (2026-09-28): the LEAD's owner - a different person
   * from `userName` (the exec conducting the visit). Plan §3 keeps the
   * telecaller as owner through VISIT_SCHEDULED, so on a scheduled visit these
   * two names legitimately differ; the dashboard shows both, labelled.
   *
   * Non-null on purpose: `Lead.ownerId` is NOT NULL with a required relation
   * (the schema's terminal-state note about ownership is not enforced as a
   * nullable column), so an owner always resolves.
   */
  leadOwnerName: string;
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
    // @Optional() (rule 7h): best-effort notifications dep. Existing test
    // factories construct VisitsService with two args; optional keeps them
    // green. Production DI resolves via @Global() NotificationsModule.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  // T-TEAM-AUTHORITATIVE (2026-09-13): stateless helper, no DI needed.
  private readonly teamAccess = new TeamAccessService();

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Manager → EVERY team they lead (T-TEAM-AUTHORITATIVE: one manager
   * may lead multiple teams), identical to LeadsService.managerTeamIds.
   * Mirrored here to avoid a circular module import (LeadsModule
   * doesn't import VisitsModule yet; pulling LeadsService into
   * VisitsModule is one-directional).
   */
  private async managerTeamIds(
    tx: PrismaClient,
    actor: JwtPayload,
  ): Promise<string[]> {
    if (actor.role !== 'MANAGER') return [];
    return this.teamAccess.getManagedTeamIds(tx as never, actor.sub, actor.organizationId);
  }

  /**
   * GET /api/visits - role-scoped list with optional filters.
   */
  async list(actor: JwtPayload, dto: VisitFilterDto): Promise<VisitListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
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

        // T-PROJFILTER (2026-09-16): the project filter is built ONCE here and
        // combined with the role scope below. It used to be written into
        // `where['lead']` and then overwritten by the role branch, which
        // silently dropped it for TELECALLER / SALES_EXEC - a lead from
        // another project could appear in a project-scoped visit list.
        const projectLeadFilter =
          dto.projectId !== undefined
            ? { lead: { projectId: dto.projectId } }
            : {};

        // Role scoping: gate via the parent Lead so RLS policies
        // (which join through Lead) are consistent. For MANAGER we
        // resolve the team via the managerId lookup.
        if (actor.role === 'SALES_EXEC') {
          // T-VISIT-ASSIGNEE (2026-09-16 owner ruling): the exec must see
          // visits ASSIGNED to them, not only visits on leads they own.
          // Under Model C the visit handoff happens while the lead is still
          // VISIT_SCHEDULED and owned by the telecaller, so an owner-only
          // scope made the visit the exec is meant to conduct invisible to
          // them - the handoff could never happen.
          where['OR'] = [
            { lead: { ...(projectLeadFilter.lead ?? {}), ownerId: actor.sub } },
            { ...projectLeadFilter, userId: actor.sub },
          ];
        } else if (actor.role === 'TELECALLER') {
          where['lead'] = { ...(projectLeadFilter.lead ?? {}), ownerId: actor.sub };
        } else if (actor.role === 'MANAGER') {
          const teamIds = await this.managerTeamIds(
            tx as unknown as PrismaClient,
            actor,
          );
          where['lead'] = {
            ...(projectLeadFilter.lead ?? {}),
            teamId: teamIds.length > 0 ? { in: teamIds } : '__no_team__',
          };
        } else if (dto.projectId !== undefined) {
          // ADMIN / OWNER: no role narrowing, but the project filter still applies.
          where['lead'] = { projectId: dto.projectId };
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
              lead: { select: { name: true, owner: { select: { name: true } } } },
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
            leadOwnerName: r.lead.owner.name,
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
   * T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28): grant the conducting exec sight
   * of the lead their visit is on.
   *
   * WHY: plan §3 says "VISIT_SCHEDULED: Telecaller owns, Sales Exec has shared
   * visibility", and the schema records the mechanism on the column itself
   * ("coOwnerId ... For VISIT_SCHEDULED shared visibility") - but nothing wrote
   * it. `lead_select_telecaller` admits TELECALLER/SALES_EXEC only when
   * `ownerId` OR `coOwnerId` matches `app.user_id`, so without this the exec
   * could read the SiteVisit they were assigned and NOT its parent Lead: every
   * `lead` relation resolved to null (a TypeError on `r.lead.name` in `list()`,
   * breaking the dashboard card for exactly the role it is built for) and they
   * could not open the lead at all.
   *
   * Written once when the visit is created, so it survives later transitions -
   * which matters because `leads.transition()` deliberately does NOT move
   * ownership (that is `reassign`'s job, and the handoff edge is reserved for
   * the exec), so the exec's own VISIT_SCHEDULED → VISITED write would
   * otherwise update a lead they cannot read.
   *
   * Narrow on purpose:
   *   - SALES_EXEC only. A MANAGER/ADMIN assignee can already read the lead via
   *     their own policy, so no grant is needed.
   *   - Skipped when the assignee is already the owner (a telecaller
   *     self-scheduling normally is).
   *   - Never clobbers an existing co-owner: `Lead.coOwnerId` is a single id,
   *     and silently replacing someone else's co-ownership to make room would
   *     revoke an access the operator granted deliberately.
   *
   * Throws `ConflictException` when the slot is held by an unrelated party
   * rather than proceeding to create a visit whose exec cannot see its own lead
   * - the same class of silent half-state this change exists to remove. The one
   * exception is `transferFrom`: re-scheduling moves the visit to a different
   * exec, and the slot should follow the exec actually conducting it, so when
   * the current co-owner is the PREVIOUS exec of this very visit the slot
   * transfers instead of colliding. `lead_update_telecaller` gates UPDATE on
   * owner-or-co-owner, so this grant is what lets the exec's own later writes
   * (VISIT_SCHEDULED → VISITED) land at all.
   */
  private async grantExecLeadVisibility(
    tx: PrismaClient,
    leadId: string,
    assignee: { id: string; role: string },
    lead: { ownerId: string; coOwnerId: string | null },
    opts?: { transferFrom?: string },
  ): Promise<void> {
    if (assignee.role !== 'SALES_EXEC') return;
    if (lead.ownerId === assignee.id) return;
    if (lead.coOwnerId === assignee.id) return;
    const isHandover =
      lead.coOwnerId !== null &&
      opts?.transferFrom !== undefined &&
      opts.transferFrom === lead.coOwnerId;
    if (lead.coOwnerId !== null && !isHandover) {
      throw new ConflictException(
        `Lead ${leadId} already has a co-owner; that slot is what carries the conducting exec's access. Reassign the lead (or clear the co-owner) before scheduling a different exec.`,
      );
    }
    await tx.lead.update({
      where: { id: leadId },
      data: { coOwnerId: assignee.id },
    });
  }

  /**
   * POST /api/visits - schedule a new visit. The lead must exist;
   * RLS policies on SiteVisit gate the write by parent Lead team.
   *
   * The DTO's `scheduledFor` is in the future (CreateSiteVisitDtoSchema
   * enforces this). `salesExecId` is optional - if omitted, the actor
   * is the assigned exec (typical telecaller-schedules flow).
   */
  async create(actor: JwtPayload, dto: CreateSiteVisitDto): Promise<VisitRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // Verify the lead exists + RLS-gated read of the parent.
        const lead = await tx.lead.findUnique({
          where: { id: dto.leadId },
          // ownerId/coOwnerId are read for the exec-visibility grant below
          // (T-VISIT-EXEC-LEAD-VISIBILITY): we only write coOwnerId when the
          // assignee cannot already see the lead.
          select: { id: true, state: true, ownerId: true, coOwnerId: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }
        // Per Plan §3: visit scheduling requires the lead to be in
        // VISIT_REQUESTED or VISIT_SCHEDULED. RESCHEDULED is allowed
        // too - a manager re-opening a no-show can re-schedule.
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

        // T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28): give the conducting exec
        // access to the lead (see the helper's doc comment for why the
        // co-owner slot carries it).
        await this.grantExecLeadVisibility(
          tx as unknown as PrismaClient,
          dto.leadId,
          assignee,
          lead,
        );

        const created = await tx.siteVisit.create({
          data: {
            leadId: dto.leadId,
            organizationId: actor.organizationId,
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
            lead: { select: { name: true, owner: { select: { name: true } } } },
            user: { select: { name: true } },
          },
        });

        // If the lead is in VISIT_REQUESTED, auto-advance to
        // VISIT_SCHEDULED - scheduling the visit is the action that
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
            organizationId: actor.organizationId,
            action: 'visit.create',
            entityType: 'SiteVisit',
            entityId: created.id,
            after: {
              leadId: created.leadId,
              scheduledFor: created.scheduledFor.toISOString(),
              userId: created.userId,
              notes: created.notes,
              // T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28): record whether this
              // schedule also granted the exec access to the lead, so the
              // access change is answerable from the audit log alone.
              execLeadAccess:
                assignee.role === 'SALES_EXEC' &&
                lead.ownerId !== assignee.id &&
                (lead.coOwnerId === null || lead.coOwnerId === assignee.id)
                  ? 'co-owner'
                  : 'not-needed',
            },
            reason: `Visit created by ${actor.email} (${actor.role})`,
          },
        });

        // Notify the assigned exec that a site visit was scheduled for them.
        this.emitBestEffort(created.userId, {
          type: 'visit.scheduled',
          title: 'Site visit scheduled',
          body: `A site visit for ${created.lead.name} was scheduled for ${created.scheduledFor.toISOString()}.`,
          leadId: created.leadId,
        });

        return {
          id: created.id,
          leadId: created.leadId,
          leadName: created.lead.name,
            leadOwnerName: created.lead.owner.name,
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
   * PATCH /api/visits/:id - update visit outcome. Drives the parent
   * lead state machine via the VisitsService → LeadsService call:
   *
   *   COMPLETED → Lead.VISITED
   *   NO_SHOW   → Lead stays (visit outcome is informational; the
   *               parent lead doesn't auto-flip on no-show - sales
   *               follow-up decides)
   *   RESCHEDULED → creates a new SiteVisit row (via reschedule())
   *   CANCELLED → Lead.VISIT_SCHEDULED stays (cancel is a state on
   *               the visit, not the lead - lead stays VISIT_REQUESTED
   *               for a re-schedule)
   */
  async updateOutcome(
    actor: JwtPayload,
    visitId: string,
    dto: UpdateVisitOutcomeDto,
  ): Promise<VisitRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.siteVisit.findUnique({
          where: { id: visitId },
          select: {
            id: true,
            leadId: true,
            status: true,
            outcome: true,
            lead: { select: { name: true, state: true, owner: { select: { name: true } } } },
            user: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Visit ${visitId} not found`);
        }

        // T-VISIT-CLOSE (2026-09-28) defence in depth: never advance the parent
        // LEAD out of a terminal state because of a visit write. Since this
        // change the cascade cancels open visits when a lead settles, so these
        // rows should not exist - but a direct service call, an in-flight
        // request, or a race against a concurrent cancel could still get here,
        // and `LOST -> VISITED` is a state-machine violation that the conflict
        // rule below (which only inspects the VISIT's own status) cannot catch.
        //
        // Refuse rather than silently skip: the caller asked for something that
        // must not happen, and a silent success would hide it.
        if (isTerminalLeadState(existing.lead.state)) {
          throw new ConflictException(
            `Lead ${existing.leadId} is ${existing.lead.state} - a settled deal cannot have its visit outcome recorded. Re-open the lead first if this visit really happened.`,
          );
        }

        // ── Conflict rule (T-D4): idempotent replay ──────────────────
        // Offline clients (PWA / future mobile) queue outcome writes and
        // replay them on reconnect. Two rules, checked in this order:
        //
        // 1. EXACT replay (visit already has status+outcome equal to the
        //    replayed outcome, i.e. the write already landed): no-op -
        //    return the current row untouched and audit the replay
        //    ATTEMPT (reason says "Idempotent replay ... - no state
        //    change"). The response is indistinguishable from the first
        //    write, so the caller's replay classification (2xx → prune
        //    from queue) converges. Without this the replay re-runs the
        //    full write path (duplicate audit row, redundant update,
        //    possible lead-state re-entry).
        //
        // 2. DIFFERENT outcome on an already-advanced visit (e.g. queued
        //    NO_SHOW but a manager marked COMPLETED first): reject with
        //    409 - server-wins per the offline-store LWW policy
        //    (conflict-resolver.ts), never a silent overwrite. The
        //    visit's state machine rejects this for non-admin actors
        //    anyway; for ADMIN/OWNER the re-open edges would otherwise
        //    let a stale replay silently flip a terminal visit. The
        //    queue surfaces the 409 as a failed entry for the user to
        //    resolve manually.
        if (
          existing.status === dto.outcome &&
          existing.outcome === dto.outcome
        ) {
          const current = await tx.siteVisit.findUniqueOrThrow({
            where: { id: visitId },
            select: {
              id: true,
              leadId: true,
              scheduledFor: true,
              userId: true,
              status: true,
              outcome: true,
              notes: true,
              updatedAt: true,
              lead: { select: { name: true, owner: { select: { name: true } } } },
              user: { select: { name: true } },
            },
          });
          await tx.auditLog.create({
            data: {
              userId: actor.sub,
              organizationId: actor.organizationId,
              action: 'visit.outcome',
              entityType: 'SiteVisit',
              entityId: current.id,
              before: { status: current.status },
              after: { status: current.status, outcome: current.outcome },
              reason: `Idempotent replay of visit outcome ${current.status} by ${actor.email} (${actor.role}) - no state change`,
            },
          });
          return {
            id: current.id,
            leadId: current.leadId,
            leadName: current.lead.name,
            leadOwnerName: current.lead.owner.name,
            scheduledFor: current.scheduledFor.toISOString(),
            userId: current.userId,
            userName: current.user.name,
            status: current.status,
            outcome: current.outcome,
            notes: current.notes,
            updatedAt: current.updatedAt.toISOString(),
          };
        }

        // Stale-write conflict (rule 2 above): the visit has already
        // advanced past SCHEDULED and the replayed/attempted outcome
        // differs from what landed. Server-wins - reject, never
        // overwrite. (Also catches genuine admin mistakes on the
        // online path; the UI surfaces the 409 as an error toast.)
        if (existing.status !== 'SCHEDULED') {
          throw new ConflictException(
            `Visit is already ${existing.status} - refusing outcome write ${dto.outcome}`,
          );
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
            lead: { select: { name: true, owner: { select: { name: true } } } },
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
            organizationId: actor.organizationId,
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
          leadOwnerName: updated.lead.owner.name,
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
   * POST /api/visits/:id/reschedule - close the old visit (RESCHEDULED)
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
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.siteVisit.findUnique({
          where: { id: visitId },
          // `userId` is the outgoing exec, needed to decide whether the lead's
          // co-owner slot should transfer to the new assignee.
          select: { id: true, leadId: true, status: true, userId: true },
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

        // T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28): a re-scheduled visit can
        // move to a DIFFERENT exec, who needs the same access the original
        // grant gave - otherwise the new exec inherits a visit they can see but
        // whose lead they cannot.
        const rescheduleLead = await tx.lead.findUnique({
          where: { id: existing.leadId },
          select: { id: true, ownerId: true, coOwnerId: true },
        });
        if (rescheduleLead === null) {
          throw new NotFoundException(`Lead ${existing.leadId} not found`);
        }
        await this.grantExecLeadVisibility(
          tx as unknown as PrismaClient,
          existing.leadId,
          assignee,
          rescheduleLead,
          // The slot follows the exec actually conducting the visit, so a
          // re-schedule to a different exec transfers it rather than colliding.
          { transferFrom: existing.userId },
        );

        // Close the old visit.
        await tx.siteVisit.update({
          where: { id: visitId },
          data: { status: 'RESCHEDULED' },
        });

        // Create the new visit.
        const created = await tx.siteVisit.create({
          data: {
            leadId: existing.leadId,
            organizationId: actor.organizationId,
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
            lead: { select: { name: true, owner: { select: { name: true } } } },
            user: { select: { name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
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
          leadOwnerName: created.lead.owner.name,
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
   * Best-effort notification emit (rule 7j). Never throws to the caller:
   * a notification failure must not break the visit write path. No-ops when
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

function assigneeName(userId: string, actor: JwtPayload): string {
  // Tiny helper for the audit-friendly notes string. Avoids a DB hit
  // on the common path; the audit row carries the full actor identity.
  return userId === actor.sub ? actor.email : userId;
}
