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
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  withRlsContext,
  type BookingStatus,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  BookingFilterDto,
  BookingTransitionDto,
  CreateBookingDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';

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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
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
          const team = await (tx as unknown as PrismaClient).team.findFirst({
            where: { managerId: actor.sub },
            select: { id: true },
          });
          where['lead'] = {
            ...(where['lead'] as object | undefined),
            teamId: team?.id ?? '__no_team__',
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
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
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: dto.leadId },
          select: { id: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }
        const unit = await (tx as unknown as PrismaClient).unit.findUnique({
          where: { id: dto.unitId },
          select: { id: true },
        });
        if (unit === null) {
          throw new NotFoundException(`Unit ${dto.unitId} not found`);
        }

        const created = await (tx as unknown as PrismaClient).booking.create({
          data: {
            leadId: dto.leadId,
            unitId: dto.unitId,
            userId: actor.sub,
            // Prisma Decimal - pass as a string to avoid float drift.
            amount: dto.amount.toFixed(2),
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
            user: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
        });

        // T-INV-SYNC: a new booking holds the unit - the inventory grid
        // must reflect it immediately (AVAILABLE → HOLD).
        await (tx as unknown as PrismaClient).unit.update({
          where: { id: dto.unitId },
          data: { status: 'HOLD' },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
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
        });

        return {
          id: created.id,
          leadId: created.leadId,
          leadName: created.lead.name,
          unitId: created.unitId,
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
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

        // Manager approval - only MANAGER/ADMIN can transition to
        // APPROVED. The full plan §0.11 approval flow (separate modal
        // + audit reason) ships later; for Pass 1 we gate at the
        // service layer.
        if (dto.toStatus === 'APPROVED' && actor.role !== 'MANAGER' && actor.role !== 'ADMIN') {
          throw new BadRequestException(
            `Only MANAGER/ADMIN can approve a booking (actor is ${actor.role})`,
          );
        }

        const updated = await (tx as unknown as PrismaClient).booking.update({
          where: { id: bookingId },
          data: {
            status: dto.toStatus,
            ...(dto.toStatus === 'APPROVED'
              ? { approvedById: actor.sub }
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
            user: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
        });

        // T-INV-SYNC: keep the inventory grid truthful as the booking
        // advances. APPROVED → unit SOLD. CANCELLED/REJECTED → unit back
        // to AVAILABLE, but only when no OTHER active booking (HOLD/TOKEN/
        // APPROVED) still references the unit.
        if (dto.toStatus === 'APPROVED') {
          await (tx as unknown as PrismaClient).unit.update({
            where: { id: updated.unitId },
            data: { status: 'SOLD' },
          });
        } else if (dto.toStatus === 'CANCELLED' || dto.toStatus === 'REJECTED') {
          const otherActive = await (tx as unknown as PrismaClient).booking.count({
            where: {
              unitId: updated.unitId,
              id: { not: bookingId },
              status: { in: ['HOLD', 'TOKEN', 'APPROVED'] },
            },
          });
          if (otherActive === 0) {
            await (tx as unknown as PrismaClient).unit.update({
              where: { id: updated.unitId },
              data: { status: 'AVAILABLE' },
            });
          }
        }

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'booking.transition',
            entityType: 'Booking',
            entityId: updated.id,
            before: { status: existing.status },
            after: { status: updated.status, approvedById: updated.approvedById },
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
          });
        }

        return {
          id: updated.id,
          leadId: updated.leadId,
          leadName: updated.lead.name,
          unitId: updated.unitId,
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
   * Best-effort notification emit (rule 7j). Never throws to the caller:
   * a notification failure must not break the booking write path. No-ops when
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
