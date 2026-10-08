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
import { isTerminalLeadState, leadStateLabel } from '@shadhil/api-types';
import { formatVisitWhen, recordLeadActivity, withDetail } from '../leads/lead-activity';
// T-VISIT-NO-SHOW-SCHEDULING (2026-09-30): the ONE list of lead states that may
// accept a visit, plus the states a new visit advances the lead out of. Both are
// imported rather than restated here so the guard, the lead picker and the
// queue's action matrix cannot drift apart (they had).
import {
  SCHEDULABLE_LEAD_STATES,
  VISIT_SCHEDULING_ADVANCES_FROM,
} from '@shadhil/api-types';

import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAccessService } from '../teams/team-access.service';

import { canTransition } from './visits.state-machine';

/** Timeline wording per recorded visit outcome. */
const VISIT_OUTCOME_SENTENCE: Readonly<Record<string, string>> = {
  COMPLETED: 'Visit completed',
  NO_SHOW: 'Visit marked no-show',
  CANCELLED: 'Visit cancelled',
  RESCHEDULED: 'Visit marked rescheduled',
  SCHEDULED: 'Visit scheduled',
};
// The LEAD state machine, aliased because this module already imports a
// `canTransition` of its own (the visit one). The two are different graphs with
// different role lanes and both are needed here: the visit guard decides whether
// the outcome itself is allowed, this one decides whether the LEAD may follow.
import { canTransition as canLeadTransition } from '../leads/leads.state-machine';
// T-LEAD-SYNC-COVERAGE (2026-09-30): the reschedule path asks the lead machine
// which states may advance to VISIT_SCHEDULED for this actor, instead of matching
// a hardcoded list of three states. One source of truth for the edge AND its role
// gate, so a new lead state or a changed lane cannot leave the sync behind.
import { allowedNextStates } from '../leads/leads.state-machine';

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
  /**
   * T-LEAD-SYNC-COVERAGE (2026-09-30): set when this write did NOT move the parent
   * lead, with the reason, so the caller can say so instead of leaving the operator
   * to notice two screens disagreeing.
   *
   * The divergence is intentional - the lead machine keeps authority over lead
   * transitions and a role that may not drive an edge simply gets no lead write
   * (see `updateOutcome` / `reschedule`). What was missing was the TELLING: the
   * visit recorded, the lead did not move, and nothing anywhere said so.
   *
   * Absent (not `null`) when the lead was synced, or when no sync was due - e.g. a
   * CANCELLED outcome, which by owner ruling never moves the lead.
   */
  leadSyncNote?: string;
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
              lead: {
                select: {
                  name: true,
                  // 2026-09-29: the lead's pipeline state travels with the visit
                  // so the visits page can show the SAME status word as the lead
                  // page. Without it the two surfaces each had to infer a status
                  // and disagreed (the visit said "Cancelled"/"Done" while the
                  // lead said "Won"/"Visited").
                  state: true,
                  owner: { select: { name: true } },
                },
              },
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
            // The lead's own pipeline state, so the visits page shows the same
            // word as the lead page instead of inventing a visit-only status.
            leadState: r.lead.state,
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
   * The lead must be in one of `SCHEDULABLE_LEAD_STATES`, and the transition it
   * then takes is the one `VISIT_SCHEDULING_ADVANCES_FROM` describes (both from
   * `@shadhil/api-types`, so the web side's picker and action matrix cannot
   * disagree with this guard).
   *
   * The DTO's `scheduledFor` is in the future (CreateSiteVisitDtoSchema
   * enforces this). `salesExecId` is optional - if omitted, the actor
   * is the assigned exec (typical telecaller-schedules flow).
   *
   * Scheduling a RE-ENGAGEMENT (NO_SHOW) supersedes the lead's outstanding
   * no-show visit in the same transaction, so the create leaves ONE visit for
   * the lead page to record an outcome against. A live SCHEDULED/RESCHEDULED
   * visit is never touched - that is a real appointment.
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
        // Which lead states may accept a new visit. The list is IMPORTED, not
        // restated: the same constant feeds the lead picker and the queue's
        // row-action matrix, so the button the operator is offered and the
        // guard that answers it cannot disagree again.
        //
        // T-VISIT-NO-SHOW-SCHEDULING (2026-09-30): NO_SHOW is in the list. A
        // no-show is a side state with a live re-engagement edge back to
        // VISIT_SCHEDULED, and booking the next visit is exactly how that edge
        // is taken - the dashboard queue has always offered "Schedule visit" on
        // those rows and the API used to answer 400. RESCHEDULED was already
        // allowed for the same reason; NO_SHOW is the state a no-show actually
        // LANDS the lead in (`updateOutcome`, NO_SHOW -> lead NO_SHOW), so the
        // guard's old comment described a case its own list could not serve.
        if (!(SCHEDULABLE_LEAD_STATES as readonly string[]).includes(lead.state)) {
          throw new BadRequestException(
            `Lead state ${lead.state} cannot accept a visit (must be ${SCHEDULABLE_LEAD_STATES.join(', ')})`,
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

        // ── Supersede the lead's outstanding no-show visit ────────────────────
        //
        // T-VISIT-NO-SHOW-SCHEDULING (2026-09-30). Before this, create() only
        // guarded the LEAD state and never looked at the lead's VISITS. The
        // states that reach it without an outstanding visit (VISIT_REQUESTED,
        // RESCHEDULED) arrived clean; NO_SHOW arrives with one, because a lead is
        // put in NO_SHOW by recording that outcome on its visit
        // (`updateOutcome`: visit NO_SHOW -> lead NO_SHOW) and the row that
        // recorded it is still there.
        //
        // WHY THAT ROW MUST BE CLOSED, not left alone. `LeadVisitPanel` resolves
        // a lead's visit with
        // `.find(v => v.status === 'SCHEDULED' || v.status === 'NO_SHOW')` and
        // aims the next outcome at whatever it finds. Leave the no-show row open
        // and the panel can pick the OLD visit, so recording the new visit's
        // outcome hits `updateOutcome`'s "already NO_SHOW -> 409" conflict rule -
        // the operator's next action fails against a visit that is already
        // history. Closing it keeps ONE record per lead for the panel to find.
        //
        // Closing as RESCHEDULED is what `reschedule()` does to the visit it
        // moves, and it is legal in the visit state machine
        // (`NO_SHOW: ['RESCHEDULED', 'CANCELLED']` for a TELECALLER). The
        // `outcome` column is deliberately NOT rewritten: `outcome: 'NO_SHOW'` is
        // the record that the customer did not turn up, and overwriting it to
        // "rescheduled" would destroy the fact the row exists to carry. Status
        // moves to RESCHEDULED, outcome keeps saying what happened - the same
        // split `reschedule()` leaves behind.
        //
        // WHAT IS DELIBERATELY NOT CLOSED: a live SCHEDULED or RESCHEDULED row
        // (the rule is "supersede a NO_SHOW row", nothing wider). In this
        // codebase both are OPEN work - `isUpcomingVisit`
        // (apps/web/src/lib/visit-status.ts) and `OPEN_VISIT_STATUSES`
        // (close-visits-for-lead.ts) both mean SCHEDULED | RESCHEDULED - so a
        // live visit is a real appointment a customer is expecting, and closing
        // it here would silently cancel it. A `VISIT_SCHEDULED` lead booking a
        // SECOND visit therefore still leaves two open rows, exactly as before
        // this change: that ambiguity is the reschedule endpoint's to resolve
        // (`docs/designs/2026-09-16-work-dashboard-telecaller-queue.md` says so),
        // and is pinned by a test below so it cannot drift silently.
        if (lead.state === 'NO_SHOW') {
          const stale = await tx.siteVisit.findMany({
            where: { leadId: dto.leadId, status: 'NO_SHOW' },
            select: { id: true, status: true, scheduledFor: true, userId: true },
          });
          for (const visit of stale) {
            await tx.siteVisit.update({
              where: { id: visit.id },
              // `outcome` untouched on purpose - see the note above.
              data: { status: 'RESCHEDULED' },
            });
            // Audited per closed row, in the same transaction as the create, so
            // the log answers "why is this visit RESCHEDULED" without a join.
            await tx.auditLog.create({
              data: {
                userId: actor.sub,
                organizationId: actor.organizationId,
                action: 'visit.reschedule',
                entityType: 'SiteVisit',
                entityId: visit.id,
                before: { status: visit.status, scheduledFor: visit.scheduledFor.toISOString() },
                after: { status: 'RESCHEDULED', supersededBy: 'visit.create' },
                reason: `Superseded by a new visit scheduled for lead ${dto.leadId} by ${actor.email} (${actor.role})`,
              },
            });
          }
        }

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

        // Advance the lead onto the state that matches the visit that now
        // exists. The old rule was `lead.state === 'VISIT_REQUESTED'` only, so a
        // NO_SHOW or RESCHEDULED lead kept reading "didn't turn up" / "was moved"
        // while a brand-new visit sat on the calendar under it.
        //
        // `VISIT_SCHEDULING_ADVANCES_FROM` is the shared list, and it is the same
        // normalisation `reschedule()` performs for a moved visit - one rule, so
        // booking a first visit and moving one cannot land the lead in two
        // different places.
        //
        // Runs on the OUTER transaction's client (transitionInTransaction),
        // never the bare service call: `transition()` opens its own
        // withRlsContext transaction on a second connection, and the visit
        // transaction above has already locked this Lead row (the co-owner
        // grant), so two connections on one row self-deadlock into a 30s
        // "expired transaction". See transitionInTransaction's doc comment.
        const advancesLead = (
          VISIT_SCHEDULING_ADVANCES_FROM as readonly string[]
        ).includes(lead.state);
        if (advancesLead) {
          await this.leadsService.transitionInTransaction(
            actor,
            {
              leadId: dto.leadId,
              toState: 'VISIT_SCHEDULED',
              notes: `Visit scheduled for ${created.scheduledFor.toISOString()}`,
            },
            tx as unknown as PrismaClient,
            // This visit writes its own richer VISIT row below: one action, one row.
            'skip',
          );
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

        await recordLeadActivity(tx, actor, {
          leadId: created.leadId,
          type: 'VISIT',
          body: withDetail(
            `Visit booked for ${formatVisitWhen(created.scheduledFor)} with ${created.user.name}${
              advancesLead ? `; lead moved to ${leadStateLabel('VISIT_SCHEDULED')}` : ''
            }`,
            created.notes,
          ),
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
            // 2026-09-29: `organizationId` and the lead's `projectId` are read so
            // the outcome notification can resolve the project's managers and the
            // org's admins. SiteVisit has NO projectId column (project is reached
            // through the lead), so it comes from the nested select rather than a
            // second read.
            organizationId: true,
            lead: {
              select: {
                name: true,
                state: true,
                projectId: true,
                owner: { select: { id: true, name: true } },
              },
            },
            user: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Visit ${visitId} not found`);
        }

        // T-LEAD-SYNC-COVERAGE (2026-09-30): the parent lead can resolve to NULL.
        // `site_visit_select_team` shows the exec a visit they are assigned, while
        // `lead_select_telecaller` shows the same exec the LEAD only when they are
        // its owner or co-owner - so an exec recording an outcome on a visit whose
        // lead was never shared to them reads the visit and NOT its lead. That is
        // the documented RLS shape (T-VISIT-EXEC-LEAD-VISIBILITY, #79), and it used
        // to crash here with `Cannot read properties of null (reading 'state')` -
        // a 500 for a legitimate request.
        //
        // Refused with a message, not swallowed: the lead sync below genuinely
        // cannot run without the lead's state, and a silent success would record the
        // visit while leaving the two records to disagree with no explanation.
        if (existing.lead === null) {
          throw new ConflictException(
            `Visit ${visitId} could not be updated: its lead is not visible to you, so the lead's state cannot be checked or synced. Ask a manager to record this outcome, or to share the lead with you first.`,
          );
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

        // ── Drive the parent lead from the visit outcome (2026-09-29) ──────────
        //
        // OWNER REQUIREMENT: "if i change anything in visits page for specific lead
        // then that changes should reflect in leads and if i change anything in
        // lead that should reflected in visits page".
        //
        // Before this, ONLY `COMPLETED` moved the lead. A no-show or a reschedule
        // recorded on the visits page changed the VISIT and left the lead sitting
        // at VISIT_SCHEDULED, so the two surfaces told different stories about the
        // same event - the lead page said "Visit booked" while the visit said
        // "Didn't show up". The lead state machine already HAS both target states
        // (`VISIT_SCHEDULED: ['VISITED','NO_SHOW','RESCHEDULED',...]`); nothing
        // was driving them.
        //
        // The mapping, and why each is what it is:
        //
        //   COMPLETED   -> VISITED           the handoff edge; exec becomes owner
        //   NO_SHOW     -> NO_SHOW           the customer did not turn up
        //   RESCHEDULED -> VISIT_SCHEDULED   NOT `RESCHEDULED` - see below
        //   CANCELLED   -> (no change)       owner ruling, 2026-09-29: "cancelling
        //                                    one visit isn't cancelling the deal".
        //                                    A cancelled visit is a cancelled
        //                                    MEETING, not a dead lead - the
        //                                    telecaller still owns it and will
        //                                    arrange another. Driving the lead
        //                                    anywhere here would corrupt the
        //                                    pipeline on a routine action.
        //
        // WHY RESCHEDULED TARGETS `VISIT_SCHEDULED`, NOT `RESCHEDULED`.
        // In the LEAD machine, RESCHEDULED's only outgoing edges are
        // ['VISIT_SCHEDULED','RNR','LOST'] - there is NO RESCHEDULED -> VISITED.
        // Setting the lead to RESCHEDULED would therefore permanently break the
        // handoff: the next COMPLETED needs VISIT_SCHEDULED -> VISITED and could
        // never fire, so the exec could no longer settle the deal. A rescheduled
        // visit means "another one will be scheduled", which IS VISIT_SCHEDULED -
        // and this matches `reschedule()`, which normalises the lead the same way
        // for exactly this reason. In the common case the lead is already
        // VISIT_SCHEDULED, so this is a same-state no-op.
        //
        // Guards, each earned:
        //  - the lead must be VISIT_SCHEDULED before NO_SHOW: that edge only
        //    exists FROM VISIT_SCHEDULED. If the lead has already moved on (e.g. a
        //    manager advanced it to NEGOTIATION by hand), forcing the visit's
        //    outcome onto it would be a transition the machine forbids.
        //  - COMPLETED only fires from VISIT_SCHEDULED (the one handoff edge).
        const leadState = existing.lead.state;
        // T-LEAD-SYNC-COVERAGE (2026-09-30): why the lead did or did not move,
        // carried out to the caller. See the return value's `leadSyncNote`.
        let leadSynced = false;
        let leadSyncNote: string | undefined;
        const leadTarget: 'VISITED' | 'NO_SHOW' | 'VISIT_SCHEDULED' | null =
          dto.outcome === 'COMPLETED'
            ? leadState === 'VISIT_SCHEDULED'
              ? 'VISITED'
              : null
            : dto.outcome === 'NO_SHOW'
              ? leadState === 'VISIT_SCHEDULED'
                ? 'NO_SHOW'
                : null
              : dto.outcome === 'RESCHEDULED'
                ? // Heal a lead left sitting in NO_SHOW/RESCHEDULED by an earlier
                  // outcome, and keep a fresh one on the live-visit state.
                  leadState === 'NO_SHOW' || leadState === 'RESCHEDULED'
                  ? 'VISIT_SCHEDULED'
                  : null
                : null;

        if (leadTarget !== null) {
          // ── The lead machine stays the AUTHORITY on lead transitions ─────────
          //
          // The two state machines genuinely disagree about who may record a
          // no-show: `visits.state-machine` lets a SALES_EXEC put NO_SHOW on a
          // VISIT, while `leads.state-machine` reserves VISIT_SCHEDULED -> NO_SHOW
          // for the TELECALLER/manager (the exec's one out-of-lane edge is
          // VISITED, the handoff - "Deliberately ONE edge, not 'add
          // VISIT_SCHEDULED to the exec lane'"). So an exec CAN have a legitimate
          // visit outcome that their role may not mirror onto the lead.
          //
          // Pre-checking with `canTransition` is what keeps that from becoming a
          // broken write: without it, the exec's perfectly valid NO_SHOW threw a
          // ForbiddenException and the whole outcome was lost (found by running
          // the existing suite - two tests failed exactly this way). The visit
          // outcome is the visit module's business; the lead state is the lead
          // module's, and this sync DEFERS rather than overrides. When the role
          // may not move the lead, the visit is still recorded and the lead simply
          // stays where it was.
          const verdict = canLeadTransition({
            from: leadState,
            to: leadTarget,
            role: actor.role,
          });
          if (verdict.ok) {
            await this.leadsService.transitionInTransaction(
              actor,
              {
                leadId: existing.leadId,
                toState: leadTarget,
                notes:
                  dto.notes ??
                  `Visit ${dto.outcome.toLowerCase()} by ${assigneeName(updated.userId, actor)}`,
              },
              tx as unknown as PrismaClient,
              'skip',
            );
            leadSynced = true;
          } else {
            // T-LEAD-SYNC-COVERAGE (2026-09-30): the deferral stays - the lead
            // machine is the authority on lead transitions and this module will not
            // override it. What changes is that it is now REPORTED, because a
            // silent deferral is how an operator ends up staring at a red visit
            // beside a "Visit booked" lead with no explanation. The message names
            // the two states and who can fix it.
            leadSyncNote =
              verdict.code === 'ROLE_FORBIDDEN'
                ? `Visit recorded. The lead stayed at ${leadState}: the ${actor.role} role cannot move it, so a manager or admin needs to update the lead.`
                : `Visit recorded. The lead stayed at ${leadState}: there is no ${leadState} -> ${leadTarget} step in the lead flow for this role.`;
          }
        } else if (leadTarget === null) {
          // No lead sync is DUE - either the outcome never moves a lead (CANCELLED,
          // by owner ruling) or the lead had already moved on by hand. Only the
          // second is worth telling the user about, because only then do the two
          // records genuinely disagree.
          const outcomeMovesLead = dto.outcome !== 'CANCELLED';
          if (outcomeMovesLead && leadState !== 'VISITED' && leadState !== 'NO_SHOW') {
            leadSyncNote = `Visit recorded. The lead stayed at ${leadState} - it had already moved on, so the visit outcome did not change it.`;
          }
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

        await recordLeadActivity(tx, actor, {
          leadId: updated.leadId,
          type: 'VISIT',
          body: withDetail(
            `${VISIT_OUTCOME_SENTENCE[dto.outcome] ?? `Visit ${dto.outcome.toLowerCase()}`} (visit on ${formatVisitWhen(updated.scheduledFor)}, ${updated.user.name})${
              leadSynced && leadTarget !== null
                ? `; lead moved to ${leadStateLabel(leadTarget)}`
                : ''
            }`,
            dto.notes,
          ),
        });

        // 2026-09-29 (owner request): the SENDER of an outcome is not the only
        // person who needs it. A site visit is the handoff point of the whole
        // pipeline - when it happens the lead moves to VISITED and becomes the
        // exec's to negotiate, so the manager and admins should hear about it
        // without opening the calendar. Before this, updateOutcome emitted
        // NOTHING, so a telecaller who booked the visit never learned its result.
        this.outcomeNotifications(actor, {
          status: updated.status,
          leadId: updated.leadId,
          leadName: updated.lead.name,
          organizationId: existing.organizationId,
          projectId: existing.lead.projectId,
          ownerId: existing.lead.owner.id,
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
          // Only present when the lead did NOT follow - see VisitRow.leadSyncNote.
          ...(leadSyncNote !== undefined ? { leadSyncNote } : {}),
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
          // 2026-09-29: the lead's `projectId` is read here as well, to resolve
          // the reschedule notification's recipients (managers+admins). It is the
          // only place in this method that already loads the lead, so the project
          // comes for free rather than via a second query.
          // `state` is read too, to keep the parent lead in step with the move.
          select: {
            id: true,
            leadId: true,
            status: true,
            userId: true,
            lead: { select: { projectId: true, state: true } },
          },
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

        // 2026-09-29 (owner request: "if visit reschedule is reschedule team
        // manager and admin/owner should know do push notification and inapp
        // notification"). Before this, reschedule emitted NOTHING - a visit could
        // slide repeatedly and no one accountable ever saw it. Recipients are the
        // project's managers and the org's admins/owner, minus the actor.
        //
        // Fire-and-forget on purpose (the helper swallows): the recipient lookup
        // is async and must not be awaited inside the write transaction, or a slow
        // lookup would hold the visit row lock open.
        void this.rescheduleNotifications(actor, {
          leadId: created.leadId,
          leadName: created.lead.name,
          organizationId: actor.organizationId,
          projectId: existing.lead.projectId,
          newScheduledFor: created.scheduledFor,
        });

        // ── Keep the parent lead in step with the move (2026-09-29) ────────────
        //
        // `reschedule()` used to change ONLY the visit rows: the old one became
        // RESCHEDULED and a new SCHEDULED row appeared, while the lead kept
        // whatever state it had. A lead whose visit had been moved twice still read
        // "Visit booked" with nothing indicating a move had happened.
        //
        // WHY THE TARGET IS `VISIT_SCHEDULED`, NOT `RESCHEDULED`.
        // The obvious move is to drive the lead to RESCHEDULED and mirror the
        // visit. That is a DEAD END, and this is the trap that decides the design:
        // in the lead state machine RESCHEDULED's only outgoing edges are
        // ['VISIT_SCHEDULED','RNR','LOST'] - there is NO RESCHEDULED -> VISITED.
        // So the moment a reschedule drove the lead to RESCHEDULED, the eventual
        // COMPLETED outcome (which needs VISIT_SCHEDULED -> VISITED) could never
        // advance the lead again: the handoff would be permanently broken and the
        // exec could no longer settle the deal.
        //
        // There IS a new visit row and it is SCHEDULED, so VISIT_SCHEDULED is the
        // state that matches the LIVE visit and keeps the VISITED handoff
        // reachable. Nothing is lost by not using the RESCHEDULED lead state: the
        // move is already recorded twice on the visit side (the closed row's
        // RESCHEDULED status + the audit trail), and the new row is the operative
        // fact.
        //
        // From RESCHEDULED/NO_SHOW the edge back to VISIT_SCHEDULED exists, so a
        // lead left there by an earlier outcome is normalised here too.
        // VISIT_REQUESTED -> VISIT_SCHEDULED is legal and is what scheduling does.
        // Terminal and advanced states (WON/LOST/RNR/VISITED/NEGOTIATION/…) are
        // left alone: those edges do not exist, and forcing one would throw and
        // fail the reschedule itself.
        //
        // ── T-LEAD-SYNC-COVERAGE (2026-09-30) ────────────────────────────────
        //
        // The target is now COMPUTED from `allowedNextStates` instead of matched
        // against the hardcoded trio above. That list silently did nothing for
        // every other state, so a visit moved on a lead sitting in CONTACTED left
        // the lead reading "Talked" with a booked visit on the calendar - and a
        // lead in CONTACTED is a real case (a visit can be booked from it).
        //
        // Asking the state machine is strictly better than the list on all counts:
        //   - covers every state whose machine allows `-> VISIT_SCHEDULED`,
        //     including CONTACTED, without a second list to maintain;
        //   - VISIT_SCHEDULED itself is a same-state no-op (`canTransition`
        //     short-circuits SAME_STATE), so it needs no special case;
        //   - terminal/advanced states have no such edge, so they are excluded by
        //     the machine rather than by being omitted from a literal;
        //   - it folds the role gate in for free, which the old code lacked
        //     entirely: a telecaller's reschedule used to reach for a lead edge its
        //     role may not drive and threw Forbidden, failing the whole move. Now
        //     the role simply gets no lead write - the same deferral semantic
        //     `updateOutcome` uses, reported to the caller instead of hidden.
        const rescheduleLeadState = existing.lead.state;
        // T-LEAD-SYNC-COVERAGE (2026-09-30): why the lead did or did not follow the
        // move, carried out to the caller (see `VisitRow.leadSyncNote`).
        let leadSynced = false;
        let leadSyncSkippedFrom: string | undefined;
        const mayRestampLead = allowedNextStates(rescheduleLeadState, actor.role).includes(
          'VISIT_SCHEDULED',
        );
        if (mayRestampLead && rescheduleLeadState !== 'VISIT_SCHEDULED') {
          await this.leadsService.transitionInTransaction(
            actor,
            {
              leadId: existing.leadId,
              toState: 'VISIT_SCHEDULED',
              notes: `Visit rescheduled to ${created.scheduledFor.toISOString()}`,
            },
            tx as unknown as PrismaClient,
            'skip',
          );
          leadSynced = true;
        } else {
          // Kept for the response's `leadSyncNote` - see the return value.
          leadSyncSkippedFrom = rescheduleLeadState;
        }

        await recordLeadActivity(tx, actor, {
          leadId: created.leadId,
          type: 'VISIT',
          body: withDetail(
            `Visit rescheduled to ${formatVisitWhen(created.scheduledFor)} with ${created.user.name}${
              leadSynced ? `; lead moved to ${leadStateLabel('VISIT_SCHEDULED')}` : ''
            }`,
            dto.notes,
          ),
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
          // Only present when the lead did NOT follow the move. See
          // `VisitRow.leadSyncNote`.
          ...(!leadSynced && leadSyncSkippedFrom !== undefined
            ? {
                leadSyncNote: `Visit moved. The lead stayed at ${leadSyncSkippedFrom}: the ${actor.role} role cannot advance it, so a manager or admin needs to update the lead.`,
              }
            : {}),
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

  /**
   * PROJECT MANAGERS + ORG ADMINS/OWNER for a visit's project, minus the actor.
   *
   * WHY THIS IS NOT JUST `visit.userId`. The owner's requirement (2026-09-29) is
   * that a RESCHEDULE is known to the people accountable for it: "if visit
   * reschedule is reschedule team manager and admin/owner should know". The exec
   * whose slot moved is one of the affected parties, but the manager of the team
   * running the project and the org's admins are the ones who can act on a visit
   * that keeps sliding.
   *
   * The actor is EXCLUDED because they performed the write and already saw the
   * confirmation - notifying someone about their own action is the noise this
   * deliberately avoids (the same reasoning as the lead-create creator/owner
   * split, which notifies the creator only when they are not already the owner).
   *
   * Managers are resolved from ProjectTeam -> Team.managerId, which is the
   * authoritative reporting line (a manager is NOT a TeamMember row - see
   * users.service, "Team.managerId, not a TeamMember row").
   *
   * Reads run inside `withRlsContext` as CRON_SERVICE, the org-scoped
   * service-account bypass, so the recipient set does not depend on the actor's
   * own role visibility. Reading as the actor would make a MANAGER's reschedule
   * notify fewer people than an ADMIN's - the recipient list must be a property
   * of the visit, not of who moved it.
   */
  private async resolveVisitRecipients(
    organizationId: string,
    projectId: string,
    actorSub: string,
  ): Promise<string[]> {
    const orgId = organizationId.length > 0 ? organizationId : (process.env['PUBLIC_ORG_ID'] ?? '');
    try {
      const found = await withRlsContext(
        this.client,
        { userId: 'cron-service', role: 'CRON_SERVICE', organizationId: orgId },
        async (tx) => {
          const p = tx as unknown as PrismaClient;
          // 1. Managers of every team assigned to this project.
          // T-SOFT-DELETE (2026-10-01): skip a soft-deleted project entirely -
          // its visit notifications must not page anyone.
          const projectTeams = await p.projectTeam.findMany({
            where: { projectId, project: { deletedAt: null } },
            select: { teamId: true },
          });
          const teamIds = projectTeams.map((pt: { teamId: string }) => pt.teamId);
          const teams =
            teamIds.length > 0
              ? await p.team.findMany({
                  where: { id: { in: teamIds }, organizationId: orgId, deletedAt: null },
                  select: { managerId: true },
                })
              : [];
          // 2. Org admins + owners.
          const admins = await p.user.findMany({
            where: {
              organizationId: orgId,
              deletedAt: null,
              role: { in: ['ADMIN', 'OWNER'] },
            },
            select: { id: true },
          });
          return {
            managerIds: teams
              .map((t: { managerId: string | null }) => t.managerId)
              .filter((id: string | null): id is string => id !== null),
            adminIds: admins.map((u: { id: string }) => u.id),
          };
        },
      );

      // Dedupe (a manager may lead two teams on the same project, and an admin
      // may also be a manager) and drop the actor.
      const unique = new Set<string>([...found.managerIds, ...found.adminIds]);
      unique.delete(actorSub);
      return [...unique];
    } catch {
      // Best-effort: a failed recipient lookup must not break the write, and
      // must not silently notify nobody-with-an-error either.
      return [];
    }
  }

  /** Emit the same payload to every recipient, best-effort, one by one. */
  private emitToMany(
    recipients: readonly string[],
    payload: { type: string; title: string; body: string; leadId?: string },
  ): void {
    for (const sub of recipients) this.emitBestEffort(sub, payload);
  }

  /**
   * Tell the accountable people a visit MOVED (2026-09-29, owner request).
   * Type `visit.rescheduled` keeps the inbox's existing `visit` tab working -
   * the notifications page filters on the `visit` prefix.
   *
   * Async and voided at the call site: the recipient lookup cannot run inside the
   * write transaction without holding the visit row lock for the duration of an
   * unrelated query.
   */
  private async rescheduleNotifications(
    actor: JwtPayload,
    ctx: {
      leadId: string;
      leadName: string;
      organizationId: string;
      projectId: string;
      newScheduledFor: Date;
    },
  ): Promise<void> {
    const recipients = await this.resolveVisitRecipients(
      ctx.organizationId,
      ctx.projectId,
      actor.sub,
    );
    this.emitToMany(recipients, {
      type: 'visit.rescheduled',
      title: `Visit rescheduled: ${ctx.leadName}`,
      body: `Moved to ${ctx.newScheduledFor.toISOString()} by ${actor.email}.`,
      leadId: ctx.leadId,
    });
  }

  /**
   * Tell the accountable people what HAPPENED on site (2026-09-29). One type per
   * outcome rather than a single `visit.outcome` with the state buried in the
   * body: the inbox can then distinguish "the visit happened" from "the customer
   * did not turn up" without parsing prose, and the push title can say it too.
   *
   * The lead owner is included. They booked the visit and may not be the exec who
   * conducted it, so without them the person who arranged it never learns it
   * happened - the exact "I scheduled a visit and heard nothing" gap.
   */
  private outcomeNotifications(
    actor: JwtPayload,
    ctx: {
      status: string;
      leadId: string;
      leadName: string;
      organizationId: string;
      projectId: string;
      ownerId?: string;
    },
  ): void {
    const { status } = ctx;
    if (status !== 'COMPLETED' && status !== 'NO_SHOW' && status !== 'CANCELLED') return;

    const VERB: Record<string, string> = {
      COMPLETED: 'completed',
      NO_SHOW: 'no-show',
      CANCELLED: 'cancelled',
    };
    const verb = VERB[status] ?? status.toLowerCase();
    const payload = {
      type: `visit.${status.toLowerCase()}`,
      title: `Visit ${verb}: ${ctx.leadName}`,
      body: `Recorded by ${actor.email}.`,
      leadId: ctx.leadId,
    };

    // The owner is emitted to directly and separately from the manager/admin set,
    // so an owner who is ALSO a manager does not miss out if the org lookup
    // happens to be slow or returns nobody.
    if (ctx.ownerId !== undefined && ctx.ownerId.length > 0 && ctx.ownerId !== actor.sub) {
      this.emitBestEffort(ctx.ownerId, payload);
    }

    void (async () => {
      const recipients = await this.resolveVisitRecipients(
        ctx.organizationId,
        ctx.projectId,
        actor.sub,
      );
      // Skip the owner here - already emitted above.
      this.emitToMany(
        recipients.filter((r) => r !== ctx.ownerId),
        payload,
      );
    })().catch(() => undefined);
  }
}

function assigneeName(userId: string, actor: JwtPayload): string {
  // Tiny helper for the audit-friendly notes string. Avoids a DB hit
  // on the common path; the audit row carries the full actor identity.
  return userId === actor.sub ? actor.email : userId;
}
