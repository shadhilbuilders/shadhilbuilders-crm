// Bookings service - REST surface for booking lifecycle (HOLD → TOKEN
// → APPROVED/REJECTED/CANCELLED).
//
// Scoping (per JWT): every read/write flows through withRlsContext.
// Booking is team-scoped via parent Lead (booking_write_team policy,
// FOR ALL with EXISTS-subquery to Lead - same pattern as SiteVisit).
// The service inherits Lead-scoped visibility: ADMIN sees all,
// MANAGER sees team, TELECALLER/SALES_EXEC see own leads.
//
// Write paths (all inside `withRlsContext`):
//   - create: new Booking in HOLD state, owner = actor. Audit row.
//   - transition: state-machine-light (HOLD → TOKEN/APPROVED/REJECTED/
//     CANCELLED). Audit row with before/after status.
//
// T-BOOK (2026-09-07) Pass 1: we don't ship the full state machine
// (the plan §18 T-ARM-style transition rules land later); transitions
// are gated by a simple "must be one of the legal next states from
// the current state" check plus the manager approval flow. Manager
// approval uses the `approvedById` column - when transitioning to
// APPROVED we set it to actor.sub if the actor is MANAGER/ADMIN.
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
  type BookingStatus,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { TransitionReasonRequired } from '@shadhil/api-types';
import type {
  BookingFilterDto,
  BookingTransitionDto,
  CreateBookingDto,
  UpdateBookingDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAccessService } from '../teams/team-access.service';
import { isAdminClass } from '../users/roles';
// T-VISIT-CLOSE (2026-09-28): a settled booking leaves no open visits behind.
// One shared helper with the lead-terminal path, so both agree on the meaning.
import { closeOpenVisitsForLead } from '../visits/close-visits-for-lead';
import {
  BOOKABLE_LEAD_STATES,
  isBookableLeadState,
  leadStateForBookings,
  shouldApplyLeadState,
} from './lead-state-sync';

/**
 * Wire shape returned by every endpoint. Matches the api-types
 * BookingFilterDto's row contract; the web app already imports this
 * shape in apps/web/src/hooks/queries/crm.ts (useBookings).
 *
 * `notes` is a real column on the Booking model (added 2026-09-10,
 * migration 20260910120000_booking_notes) and is persisted on create.
 */
export interface BookingRow {
  id: string;
  leadId: string;
  leadName: string;
  unitId: string;
  /** T-BOOK-UNIT: denormalized for the bookings grid ("Unit" column). */
  unitNumber: string;
  userId: string;
  userName: string;
  amount: string;
  tokenAmount: string | null;
  status: BookingStatus;
  approvedById: string | null;
  approvedByName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingListResult {
  total: number;
  rows: BookingRow[];
}

/**
 * Legal next states from a given current state. Kept as a pure
 * function so it can be unit-tested without a DB. The transitions
 * follow the plan §0.11 flow:
 *   - HOLD → TOKEN (token payment received) | CANCELLED
 *   - TOKEN → APPROVED (manager approval) | REJECTED | CANCELLED
 *   - APPROVED → CANCELLED (rare refund path)
 *   - REJECTED, CANCELLED → terminal
 */
export function legalNextStates(from: BookingStatus): BookingStatus[] {
  switch (from) {
    case 'HOLD':
      return ['TOKEN', 'CANCELLED'];
    case 'TOKEN':
      return ['APPROVED', 'REJECTED', 'CANCELLED'];
    case 'APPROVED':
      return ['CANCELLED'];
    case 'REJECTED':
    case 'CANCELLED':
      return [];
  }
}

/** Unit statuses a unit may be in when a NEW booking starts (T-INV-SYNC). */
const BOOKABLE_UNIT_STATUSES = ['AVAILABLE'] as const;

/**
 * Prisma unique-constraint violation. The partial index
 * `one_active_booking_per_unit` raises this when a second active booking is
 * created for the same unit (including a race between two concurrent creates).
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class BookingsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    // @Optional() (rule 7h): best-effort notifications dep. Existing test
    // factories construct BookingsService with one arg; optional keeps them
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
   * GET /api/bookings?status=...&leadId=... - role-scoped list.
   * Same scoping as leads/visits: ADMIN sees all, MANAGER sees team
   * via teamId lookup, TELECALLER/SALES_EXEC see own leads via the
   * parent Lead's ownerId.
   */
  async list(
    actor: JwtPayload,
    dto: BookingFilterDto,
  ): Promise<BookingListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (dto.leadId !== undefined) where['leadId'] = dto.leadId;
        if (dto.unitId !== undefined) where['unitId'] = dto.unitId;
        // T-ProjectSwitch: filter by the active project via the parent
        // Lead (Booking has no projectId of its own; its unit's project
        // always matches the lead's project in practice).
        if (dto.projectId !== undefined) {
          where['lead'] = { ...(where['lead'] as object | undefined), projectId: dto.projectId };
        }
        if (dto.approvedById !== undefined)
          where['approvedById'] = dto.approvedById;
        if (dto.status !== undefined) {
          where['status'] = Array.isArray(dto.status)
            ? { in: dto.status }
            : dto.status;
        }
        // Server-side search over the parent Lead's name/phone (the
        // booking has no name of its own). Mirrors the leads D9 contract.
        if (dto.search !== undefined && dto.search.length > 0) {
          where['lead'] = {
            ...(where['lead'] as object | undefined),
            OR: [
              { name: { contains: dto.search, mode: 'insensitive' } },
              { phone: { contains: dto.search } },
            ],
          };
        }

        // Role scoping via parent Lead. The booking policies already
        // JOIN to Lead - the role-scoped lane just narrows the `where`
        // further for staff. Merge with any existing lead filter (search,
        // projectId) so staff search still applies.
        if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
          where['lead'] = {
            ...(where['lead'] as object | undefined),
            ownerId: actor.sub,
          };
        } else if (actor.role === 'MANAGER') {
          const teamIds = await this.teamAccess.getManagedTeamIds(
            tx as never,
            actor.sub,
            actor.organizationId,
          );
          where['lead'] = {
            ...(where['lead'] as object | undefined),
            teamId: teamIds.length > 0 ? { in: teamIds } : '__no_team__',
          };
        }

        const [rows, total] = await Promise.all([
          (tx as unknown as PrismaClient).booking.findMany({
            where,
            take: dto.limit,
            skip: dto.offset,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              leadId: true,
              unitId: true,
              userId: true,
              amount: true,
              tokenAmount: true,
              status: true,
              approvedById: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              lead: { select: { name: true } },
              unit: { select: { unitNumber: true } },
              user: { select: { name: true } },
              approvedBy: { select: { name: true } },
            },
          }),
          (tx as unknown as PrismaClient).booking.count({ where }),
        ]);

        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            leadId: r.leadId,
            leadName: r.lead.name,
            unitId: r.unitId,
            unitNumber: r.unit.unitNumber,
            userId: r.userId,
            userName: r.user.name,
            amount: r.amount.toString(),
            tokenAmount: r.tokenAmount?.toString() ?? null,
            status: r.status,
            approvedById: r.approvedById,
            approvedByName: r.approvedBy?.name ?? null,
            notes: r.notes,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
        };
      },
    );
  }

  /**
   * GET /api/bookings/:id - single booking (approval page). Role-scoped
   * by the same RLS policies as list; a booking the actor cannot see
   * 404s (findUnique returns null under RLS).
   */
  async findOne(actor: JwtPayload, bookingId: string): Promise<BookingRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const row = await (tx as unknown as PrismaClient).booking.findUnique({
          where: { id: bookingId },
          select: {
            id: true,
            leadId: true,
            unitId: true,
            userId: true,
            amount: true,
            tokenAmount: true,
            status: true,
            approvedById: true,
            notes: true,
            createdAt: true,
            updatedAt: true,
            lead: { select: { name: true } },
            unit: { select: { unitNumber: true } },
            user: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
        });
        if (row === null) {
          throw new NotFoundException(`Booking ${bookingId} not found`);
        }
        return {
          id: row.id,
          leadId: row.leadId,
          leadName: row.lead.name,
          unitId: row.unitId,
          unitNumber: row.unit.unitNumber,
          userId: row.userId,
          userName: row.user.name,
          amount: row.amount.toString(),
          tokenAmount: row.tokenAmount?.toString() ?? null,
          status: row.status,
          approvedById: row.approvedById,
          approvedByName: row.approvedBy?.name ?? null,
          notes: row.notes,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * POST /api/bookings - start a new booking in HOLD state. The
   * booking_write_team RLS policy gates the INSERT via the parent
   * Lead's team/owner.
   */
  async create(
    actor: JwtPayload,
    dto: CreateBookingDto,
  ): Promise<BookingRow> {
    // T-BOOK-ROLES (2026-09-15): creating a booking IS initiating one
    // (it lands in HOLD), so it carries the same role gate as HOLD → TOKEN.
    // TELECALLER is excluded per DESIGN.md §4 ("Initiate booking" ❌). The web
    // form already hides itself from TELECALLER; this is the enforcement
    // layer, and the RLS write policy only scopes by lead owner/team - it does
    // not know about roles.
    if (
      actor.role !== 'MANAGER' &&
      actor.role !== 'SALES_EXEC' &&
      !isAdminClass(actor.role)
    ) {
      throw new ForbiddenException(
        `Only MANAGER/SALES_EXEC/ADMIN/OWNER can create a booking (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: dto.leadId },
          select: { id: true, state: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // T-BOOK-LEADSYNC (2026-09-15): a booking starts the deal, so the lead
        // must already be under negotiation. Without this guard a booking could
        // be opened on a lead still at NEW/CONTACTED/VISIT_*, skipping the
        // whole sales conversation - and the leads page would show "New" for a
        // customer with a villa on hold.
        if (!isBookableLeadState(lead.state)) {
          throw new ConflictException(
            `Lead is ${lead.state} - a booking can only start from ` +
              `${BOOKABLE_LEAD_STATES.join(', ')}. Move the lead to NEGOTIATION first.`,
          );
        }
        const unit = await (tx as unknown as PrismaClient).unit.findUnique({
          where: { id: dto.unitId },
          // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16, owner ruling): `price` is
          // selected so the server can DERIVE the amount rather than trust the
          // client. See the amount handling below.
          select: { id: true, unitNumber: true, status: true, price: true },
        });
        if (unit === null) {
          throw new NotFoundException(`Unit ${dto.unitId} not found`);
        }

        // T-INV-SYNC: a unit already occupied by an active booking cannot take
        // a second one. The partial unique index
        // (one_active_booking_per_unit) is the hard guarantee - this guard
        // exists to return a readable 409 instead of a raw constraint error.
        if (!(BOOKABLE_UNIT_STATUSES as readonly string[]).includes(unit.status)) {
          throw new ConflictException(
            `Unit ${unit.unitNumber} is ${unit.status} and cannot take a new booking. ` +
              'Pick an AVAILABLE unit, or clear the existing booking on this one.',
          );
        }

        // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16): the unit's price is the booking
        // amount. Prisma returns Decimal as an object with `toFixed`; guard the
        // shape so a schema change fails here rather than writing a bogus amount.
        const unitPrice = Number(unit.price);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          throw new ConflictException(
            `Unit ${unit.unitNumber} has no usable price (got ${String(unit.price)}), so a booking ` +
              'amount cannot be derived. Set a price on the unit first.',
          );
        }

        // Reject a client that sends a different figure instead of quietly
        // overwriting it: silently correcting would hide a UI bug, and the whole
        // point of this change is that the two can no longer disagree unnoticed.
        // 1 rupee tolerance absorbs rounding on the wire, nothing more.
        if (Math.abs(dto.amount - unitPrice) > 1) {
          throw new BadRequestException(
            `Booking amount must equal the unit price: unit ${unit.unitNumber} is ` +
              `${unitPrice.toFixed(2)}, but ${dto.amount.toFixed(2)} was sent. ` +
              'The total comes from the selected unit.',
          );
        }

        let created;
        try {
          created = await (tx as unknown as PrismaClient).booking.create({
            data: {
              leadId: dto.leadId,
              organizationId: actor.organizationId,
              unitId: dto.unitId,
              userId: actor.sub,
              // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16, owner ruling): the
              // booking total IS the unit's price - "the price is the price".
              //
              // This used to write `dto.amount` straight through, so the client
              // decided the figure and nothing cross-checked it. In practice EVERY
              // existing booking disagreed with its unit (₹1 and ₹1212 against a
              // ₹43,50,000 unit), which corrupts booking value, approval totals and
              // reports. The server is the authority now: the amount comes from the
              // unit, and a client that sends a different figure is rejected
              // loudly rather than silently ignored, so the UI bug cannot hide.
              //
              // Prisma Decimal - pass as a string to avoid float drift.
              amount: unitPrice.toFixed(2),
              ...(dto.tokenAmount !== undefined
                ? { tokenAmount: dto.tokenAmount.toFixed(2) }
                : {}),
              ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
              status: 'HOLD',
            },
            select: {
              id: true,
              leadId: true,
              unitId: true,
              userId: true,
              amount: true,
              tokenAmount: true,
              status: true,
              approvedById: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              lead: { select: { name: true } },
              unit: { select: { unitNumber: true } },
              user: { select: { name: true } },
              approvedBy: { select: { name: true } },
            },
          });
        } catch (err) {
          // Race: another request created an active booking for this unit
          // between the guard above and this INSERT.
          if (isUniqueViolation(err)) {
            throw new ConflictException(
              `Unit ${unit.unitNumber} already has an active booking.`,
            );
          }
          throw err;
        }

        // T-INV-SYNC: the Unit.status change (AVAILABLE → HOLD) is applied by
        // the unit_status_sync_booking trigger on "Booking" - a SECURITY
        // DEFINER function, so it works for EVERY role. Application code no
        // longer writes Unit.status on the booking path: the previous
        // service-level update silently matched zero rows for
        // MANAGER/SALES_EXEC/TELECALLER (Unit UPDATE was ADMIN-only under
        // RLS), which is exactly how the two pages drifted apart.

        // T-BOOK-LEADSYNC: a new HOLD moves the lead along the pipeline in the
        // same transaction. Forward-only (allowRegress false) - a new booking
        // never pulls a lead backwards.
        await this.syncLeadState(tx, created.leadId, { allowRegress: false, actor });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'booking.create',
            entityType: 'Booking',
            entityId: created.id,
            after: {
              leadId: created.leadId,
              unitId: created.unitId,
              amount: created.amount.toString(),
              status: created.status,
            },
            reason: `Booking created by ${actor.email} (${actor.role})`,
          },
        });

        // Notify the booking owner that their booking is on hold awaiting
        // manager approval.
        this.emitBestEffort(created.userId, {
          type: 'booking.created',
          title: 'Booking on hold',
          body: `Booking for ${created.lead.name} (${created.amount.toString()}) is awaiting approval.`,
          leadId: created.leadId,
          bookingId: created.id,
        });

        return {
          id: created.id,
          leadId: created.leadId,
          leadName: created.lead.name,
          unitId: created.unitId,
          unitNumber: created.unit.unitNumber,
          userId: created.userId,
          userName: created.user.name,
          amount: created.amount.toString(),
          tokenAmount: created.tokenAmount?.toString() ?? null,
          status: created.status,
          approvedById: created.approvedById,
          approvedByName: created.approvedBy?.name ?? null,
          notes: created.notes,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/bookings/:id - advance the booking state. The DTO's
   * toStatus is validated against legalNextStates() from the current
   * state. APPROVED transitions also set approvedById = actor.sub.
   */
  async transition(
    actor: JwtPayload,
    bookingId: string,
    dto: BookingTransitionDto,
  ): Promise<BookingRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).booking.findUnique(
          {
            where: { id: bookingId },
            select: {
              id: true,
              status: true,
              leadId: true,
              unitId: true,
              userId: true,
              amount: true,
              tokenAmount: true,
              approvedById: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              lead: { select: { name: true } },
              unit: { select: { unitNumber: true } },
              user: { select: { name: true } },
              approvedBy: { select: { name: true } },
            },
          },
        );
        if (existing === null) {
          throw new NotFoundException(`Booking ${bookingId} not found`);
        }

        const allowed = legalNextStates(existing.status);
        if (!allowed.includes(dto.toStatus)) {
          throw new BadRequestException(
            `Cannot transition booking from ${existing.status} to ${dto.toStatus} (allowed: ${allowed.join(', ') || '<none - terminal>'})`,
          );
        }

        // T-BOOK-ROLES (2026-09-15): role gates per DESIGN.md §4. Before this,
        // the ONLY gate was on APPROVED and it omitted OWNER; HOLD → TOKEN (the
        // "initiate booking" step) had NO role gate at all, so a TELECALLER who
        // owned the lead could advance a booking.
        //
        //   Initiate booking (HOLD → TOKEN):  ADMIN/OWNER/MANAGER/SALES_EXEC
        //     - TELECALLER is excluded (DESIGN.md §4 "Initiate booking" ❌).
        //   Approve booking (→ APPROVED/REJECTED): ADMIN/OWNER only.
        //     - MANAGER was revoked 2026-09-24 (owner decision): approving is an
        //       admin/owner act, not a manager one. DESIGN.md §4 + the module
        //       table were updated in the same change (AGENTS.md: the plan is
        //       the spec, so code and matrix must move together).
        //     - Uses isAdminClass() so OWNER is included: OWNER downcasts to
        //       ADMIN at the RLS layer, and the permission matrix grants Super
        //       Admin ✅. An earlier literal `!== 'ADMIN'` check let an owner
        //       press Approve and get a 400 saying they were neither.
        //     - RLS is deliberately NOT involved: role rules stay in the service
        //       (see references/authorization-role-gates.md). booking_write_admin
        //       already covers ADMIN/OWNER at the row level.
        //
        // The full plan §0.11 approval flow (separate modal + audit reason)
        // ships later; for now the gate lives here, in the same transaction as
        // the status write.
        if (
          dto.toStatus === 'TOKEN' &&
          actor.role !== 'MANAGER' &&
          actor.role !== 'SALES_EXEC' &&
          !isAdminClass(actor.role)
        ) {
          throw new ForbiddenException(
            `Only MANAGER/SALES_EXEC/ADMIN/OWNER can start a booking (actor is ${actor.role})`,
          );
        }

        if (
          (dto.toStatus === 'APPROVED' || dto.toStatus === 'REJECTED') &&
          !isAdminClass(actor.role)
        ) {
          throw new ForbiddenException(
            `Only ADMIN/OWNER can approve or reject a booking (actor is ${actor.role})`,
          );
        }

        // A cancel or reject must carry an operator-supplied reason: the audit
        // row and the customer follow-up depend on it, and a generated
        // "moved by <email>" string is not a reason. The DTO's superRefine
        // already rejects a blank reason, but the service refuses it too so a
        // direct service call (or an older client) cannot slip through - the
        // live service accepted exactly that before this guard.
        if (
          TransitionReasonRequired.has(dto.toStatus) &&
          (dto.reason ?? '').trim().length === 0
        ) {
          throw new BadRequestException(
            `A reason is required when moving a booking to ${dto.toStatus}`,
          );
        }

        // T-TOKEN-GATE (2026-09-28): the invariant behind HOLD → TOKEN is that
        // the token WAS received, and `tokenAmount` is the only record of how
        // much. The DTO requires it from a client, but the service enforces the
        // INVARIANT too, so a direct service call or a racing older client
        // cannot leave a booking marked token-received with no amount - which is
        // both unverifiable and actively misread downstream (the admin "Booking
        // money" card renders a NULL token as "HOLD - no token", i.e. money
        // still with the customer).
        //
        // Tolerant where the DTO is strict: an amount recorded at HOLD time
        // (CreateBookingDto accepts one) already satisfies the invariant, so a
        // transition that omits it is fine as long as the stored value is
        // positive. The rule is "one must EXIST", not "one must be sent".
        const stored = existing.tokenAmount === null ? 0 : Number(existing.tokenAmount);
        const incoming = dto.tokenAmount;
        if (incoming !== undefined && !(incoming > 0)) {
          throw new BadRequestException(
            'Token amount must be greater than zero when marking the token as received',
          );
        }
        if (dto.toStatus === 'TOKEN' && incoming === undefined && !(stored > 0)) {
          throw new BadRequestException(
            'A token amount is required to mark the token as received. Enter the amount received (or record it on the booking first).',
          );
        }

        // T-TOKEN-GATE (2026-09-28, owner instruction): "Don't approve booking
        // without token amount".
        //
        // Approving asserts that the token was RECEIVED, so it is only meaningful
        // against a recorded amount - and approving without one is exactly how a
        // money figure gets lost. Until this, `TOKEN → APPROVED` was reachable on
        // a booking whose `tokenAmount` was NULL (the very rows the old transition
        // produced), which meant the deal could be closed with the payment
        // permanently unrecorded: the "Booking money" card then reports a paid
        // booking as "no token".
        //
        // Checked independently of the HOLD → TOKEN rule above, because the two
        // are different holes: that one prevents CREATING the defect, this one
        // prevents CEMENTING an existing one. A booking already in TOKEN with a
        // NULL amount (from production data) therefore cannot be approved until
        // its amount is recorded - the bookings edit form writes that field, and
        // `update()` refuses to clear it again.
        if (dto.toStatus === 'APPROVED' && !(stored > 0)) {
          throw new BadRequestException(
            'A token amount must be recorded before this booking can be approved. Enter the amount actually received on the booking first.',
          );
        }

        const updated = await (tx as unknown as PrismaClient).booking.update({
          where: { id: bookingId },
          data: {
            status: dto.toStatus,
            ...(dto.toStatus === 'APPROVED'
              ? { approvedById: actor.sub }
              : {}),
            // Written in the SAME update as the status, so the two can never
            // drift into "TOKEN with no amount". `toFixed(2)` matches how the
            // column is written everywhere else (Prisma Decimal over a string).
            ...(dto.toStatus === 'TOKEN' && incoming !== undefined
              ? { tokenAmount: incoming.toFixed(2) }
              : {}),
          },
          select: {
            id: true,
            leadId: true,
            unitId: true,
            userId: true,
            amount: true,
            tokenAmount: true,
            status: true,
            approvedById: true,
            notes: true,
            createdAt: true,
            updatedAt: true,
            lead: { select: { name: true } },
            unit: { select: { unitNumber: true } },
            user: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
        });

        // T-VISIT-CLOSE (2026-09-28): once the booking is settled - approved
        // (the unit is sold) or cancelled/rejected (the deal is dead) - any open
        // visit on its lead is no longer pending work. Nothing used to close
        // them, so they lingered with a past `scheduledFor` and showed up in the
        // "Visits at risk" card, the visit list and the calendar.
        //
        // TOKEN is deliberately EXCLUDED: the token is paid but approval is
        // still pending, so the deal is live and a scheduled visit may be
        // exactly what closes it.
        if (
          dto.toStatus === 'APPROVED' ||
          dto.toStatus === 'REJECTED' ||
          dto.toStatus === 'CANCELLED'
        ) {
          await closeOpenVisitsForLead(
            tx as unknown as PrismaClient,
            actor,
            updated.leadId,
            'booking-settled',
          );
        }

        // T-INV-SYNC: the Unit.status follow-through (APPROVED → SOLD,
        // CANCELLED/REJECTED → back to AVAILABLE/HOLD/TOKEN depending on the
        // unit's remaining bookings) is applied by the
        // unit_status_sync_booking trigger on "Booking". The service used to
        // do it here and the write silently matched zero rows for every
        // non-ADMIN role under RLS - the trigger is role-independent, so the
        // inventory grid is now correct for whoever advances the booking.

        // T-BOOK-LEADSYNC: keep the lead in step with the booking. A cancel or
        // reject RELEASES the deal, so allowRegress is true for those - the lead
        // re-enters the pipeline at NEGOTIATION instead of staying parked on
        // WON. Ordinary progressions stay forward-only.
        await this.syncLeadState(tx, updated.leadId, {
          allowRegress: dto.toStatus === 'CANCELLED' || dto.toStatus === 'REJECTED',
          actor,
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'booking.transition',
            entityType: 'Booking',
            entityId: updated.id,
            before: { status: existing.status },
            after: { status: updated.status, approvedById: updated.approvedById },
            // For a cancel/reject the reason is guaranteed non-blank by the
            // guard above (and by the DTO), so it is always the operator's own
            // words here. The generated fallback remains for the moves that
            // legitimately have no reason (HOLD → TOKEN, → APPROVED).
            reason:
              dto.reason ??
              `Booking ${existing.status} → ${updated.status} by ${actor.email} (${actor.role})`,
          },
        });

        // Notify the booking owner that its status changed (e.g. approved,
        // rejected). Skip when the actor IS the owner (they made the change).
        if (updated.userId !== actor.sub) {
          this.emitBestEffort(updated.userId, {
            type: 'booking.transition',
            title: 'Booking status changed',
            body: `Booking for ${updated.lead.name} moved to ${updated.status}.`,
            leadId: updated.leadId,
            bookingId: updated.id,
          });
        }

        return {
          id: updated.id,
          leadId: updated.leadId,
          leadName: updated.lead.name,
          unitId: updated.unitId,
          unitNumber: updated.unit.unitNumber,
          userId: updated.userId,
          userName: updated.user.name,
          amount: updated.amount.toString(),
          tokenAmount: updated.tokenAmount?.toString() ?? null,
          status: updated.status,
          approvedById: updated.approvedById,
          approvedByName: updated.approvedBy?.name ?? null,
          notes: updated.notes,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/bookings/:id - edit the editable booking fields
   * (amount / tokenAmount / notes). Status changes go through
   * /transition. Role-gated: ADMIN/OWNER/MANAGER can edit any booking
   * they can see; TELECALLER/SALES_EXEC can edit only their own
   * (the RLS write policy already scopes by parent Lead owner/team).
   */
  async update(
    actor: JwtPayload,
    bookingId: string,
    dto: UpdateBookingDto,
  ): Promise<BookingRow> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).booking.findUnique(
          {
            where: { id: bookingId },
            select: {
              id: true,
              status: true,
              leadId: true,
              unitId: true,
              userId: true,
              amount: true,
              tokenAmount: true,
              approvedById: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              lead: { select: { name: true } },
              unit: { select: { unitNumber: true } },
              user: { select: { name: true } },
              approvedBy: { select: { name: true } },
            },
          },
        );
        if (existing === null) {
          throw new NotFoundException(`Booking ${bookingId} not found`);
        }

        const data: Record<string, unknown> = {};
        if (dto.amount !== undefined) data['amount'] = dto.amount.toFixed(2);
        if (dto.tokenAmount !== undefined) {
          // T-TOKEN-GATE (2026-09-28): a booking that is already TOKEN was marked
          // token-received because money came in - its amount is therefore
          // REQUIRED, and clearing it here re-creates exactly the anomaly the
          // transition rule exists to prevent (an unverifiable "paid" booking
          // that the admin "Booking money" card reads as "no token", i.e. money
          // still with the customer). Without this guard the edit form could
          // silently undo a repair made from this same form.
          //
          // Correcting the amount is still allowed; only REMOVING it is not.
          if (existing.status === 'TOKEN' && dto.tokenAmount === null) {
            throw new BadRequestException(
              'This booking is marked as token received, so the token amount cannot be cleared. Enter the amount actually received instead.',
            );
          }
          data['tokenAmount'] =
            dto.tokenAmount === null ? null : dto.tokenAmount.toFixed(2);
        }
        if (dto.notes !== undefined) data['notes'] = dto.notes;

        const updated = await (tx as unknown as PrismaClient).booking.update({
          where: { id: bookingId },
          data,
          select: {
            id: true,
            leadId: true,
            unitId: true,
            userId: true,
            amount: true,
            tokenAmount: true,
            status: true,
            approvedById: true,
            notes: true,
            createdAt: true,
            updatedAt: true,
            lead: { select: { name: true } },
            unit: { select: { unitNumber: true } },
            user: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'booking.update',
            entityType: 'Booking',
            entityId: updated.id,
            before: {
              amount: existing.amount.toString(),
              tokenAmount: existing.tokenAmount?.toString() ?? null,
              notes: existing.notes,
            },
            after: {
              amount: updated.amount.toString(),
              tokenAmount: updated.tokenAmount?.toString() ?? null,
              notes: updated.notes,
            },
            reason: `Booking ${updated.id} updated by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: updated.id,
          leadId: updated.leadId,
          leadName: updated.lead.name,
          unitId: updated.unitId,
          unitNumber: updated.unit.unitNumber,
          userId: updated.userId,
          userName: updated.user.name,
          amount: updated.amount.toString(),
          tokenAmount: updated.tokenAmount?.toString() ?? null,
          status: updated.status,
          approvedById: updated.approvedById,
          approvedByName: updated.approvedBy?.name ?? null,
          notes: updated.notes,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        };
      },
    );
  }

  /**
   * DELETE /api/bookings/:id - remove a booking. Role-gated: ADMIN/OWNER
   * only (mirrors the inventory unit delete). Frees the unit back to
   * AVAILABLE when no OTHER active booking (HOLD/TOKEN/APPROVED) still
   * references it. Audit row records the deleted booking's details.
   */
  async delete(actor: JwtPayload, bookingId: string): Promise<{ id: string }> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can delete a booking (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).booking.findUnique(
          {
            where: { id: bookingId },
            select: {
              id: true,
              leadId: true,
              unitId: true,
              userId: true,
              amount: true,
              tokenAmount: true,
              status: true,
              approvedById: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              lead: { select: { name: true } },
              unit: { select: { unitNumber: true } },
              user: { select: { name: true } },
              approvedBy: { select: { name: true } },
            },
          },
        );
        if (existing === null) {
          throw new NotFoundException(`Booking ${bookingId} not found`);
        }

        await (tx as unknown as PrismaClient).booking.delete({
          where: { id: bookingId },
        });

        // T-INV-SYNC: freeing the unit is handled by the
        // unit_status_sync_booking trigger on "Booking" (AFTER DELETE):
        // Unit.status recomputes from the unit's remaining active bookings
        // (SOLD > TOKEN > HOLD > AVAILABLE). Role-independent, unlike the
        // admin-only Unit UPDATE policy this code used to rely on.

        // T-BOOK-LEADSYNC: the booking is gone, so the lead re-syncs from
        // whatever bookings remain (none → NEGOTIATION). allowRegress because
        // removing the booking is a release, not a progression.
        await this.syncLeadState(tx, existing.leadId, { allowRegress: true, actor });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'booking.delete',
            entityType: 'Booking',
            entityId: bookingId,
            before: {
              leadId: existing.leadId,
              unitId: existing.unitId,
              amount: existing.amount.toString(),
              status: existing.status,
            },
            reason: `Booking ${bookingId} deleted by ${actor.email} (${actor.role})`,
          },
        });

        return { id: bookingId };
      },
    );
  }

  /**
   * T-BOOK-LEADSYNC (2026-09-15): reconcile `Lead.state` with the lead's
   * bookings. Called from every booking write path (create / transition /
   * delete) inside the SAME transaction, so the booking and the lead can never
   * diverge.
   *
   * Most-advanced active booking wins (APPROVED > TOKEN > HOLD); with no active
   * booking the lead returns to NEGOTIATION. Backwards moves are only applied
   * for an explicit release (`allowRegress`) - a cancel/reject/open-again -
   * which is what keeps a re-synced stale HOLD from dragging a WON lead back.
   *
   * `allowRegress` is false for ordinary progressions, and true when the
   * booking just LEFT the active set (CANCELLED/REJECTED, or a delete) so the
   * deal re-enters the pipeline instead of staying parked on WON.
   */
  private async syncLeadState(
    tx: unknown,
    leadId: string,
    options: { allowRegress: boolean; actor: JwtPayload },
  ): Promise<void> {
    const client = tx as unknown as PrismaClient;
    const lead = await client.lead.findUnique({
      where: { id: leadId },
      select: { id: true, state: true, organizationId: true },
    });
    if (lead === null) return;

    const bookings = await client.booking.findMany({
      where: { leadId },
      select: { status: true },
    });
    const target = leadStateForBookings(bookings.map((b) => b.status));

    if (!shouldApplyLeadState(lead.state, target, options)) return;

    await client.lead.update({
      where: { id: leadId },
      data: { state: target },
    });

    // Audit trail. userId MUST be the acting user: the
    // auditlog_insert_any_authenticated policy requires app.user_id IS NOT NULL
    // (a null actor violates RLS with P2039 - caught by the live check). The
    // action name marks it as a system-derived write rather than a user
    // transition of the lead.
    await client.auditLog.create({
      data: {
        userId: options.actor.sub,
        organizationId: lead.organizationId,
        action: 'lead.state_sync',
        entityType: 'Lead',
        entityId: leadId,
        before: { state: lead.state },
        after: { state: target },
        reason:
          'Lead state synced from its bookings (T-BOOK-LEADSYNC): ' +
          'APPROVED→WON, TOKEN→BOOKING_INITIATED, HOLD→NEGOTIATION, none→NEGOTIATION',
      },
    });
  }

  /**
   * Best-effort notification emit (rule 7j). Never throws to the caller:
   * a notification failure must not break the booking write path. No-ops when
   * the notifications dep is absent (test harness) or emit throws.
   */
  private emitBestEffort(
    recipientSub: string,
    payload: { type: string; title: string; body: string; leadId?: string; bookingId?: string },
  ): void {
    if (this.notifications === undefined) return;
    try {
      void this.notifications.emit(recipientSub, payload).catch(() => undefined);
    } catch {
      // swallow - best-effort
    }
  }
}
