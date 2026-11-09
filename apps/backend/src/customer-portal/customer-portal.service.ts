// Customer portal service (issue #8 slice 2): the buyer's read-only view of
// their own unit(s). Separate from customer-progress because the actor model
// differs (a CUSTOMER is tied to a Lead, not to a project team).
//
// Authorization, in order, all here with RLS as the second wall:
//   1. role must be CUSTOMER                         -> 403
//   2. User.customerLeadId must be set               -> 403 CUSTOMER_NOT_LINKED
//      (carries the office phone for the lock screen)
//   3. unit must be on the caller's APPROVED booking -> 404 (never 403: a 403
//      would confirm that some other buyer's unit exists)
// RLS denies by returning an empty set, so every "not found" below is a
// deliberate service decision, not something RLS tells us.
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext, type RlsTx } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import { CodedForbiddenException } from '../common/errors/coded-exception';
import { PrismaService } from '../prisma/prisma.module';
import { readTimelinePage, type TimelineResponseDto } from '../customer-progress/progress-photo.mapper';

export interface PortalUnitDto {
  unitId: string;
  unitNumber: string;
  projectName: string;
  projectId: string;
  /** Phase of the newest photo; null until the first photo lands. */
  currentPhaseName: string | null;
  photoCount: number;
  /** Staff-entered handover estimate (ISO), or null when not set. */
  expectedHandoverDate: string | null;
  /** The project's buyer-visible checkpoints, in staff-defined order. */
  milestones: PortalMilestoneDto[];
}

export interface PortalMilestoneDto {
  id: string;
  name: string;
  targetDate: string | null;
  /** Null until staff mark the milestone reached. */
  completedAt: string | null;
}

export interface PortalMeDto {
  customerName: string;
  units: PortalUnitDto[];
}

export const NOT_LINKED_CODE = 'CUSTOMER_NOT_LINKED';

/** "A-2" before "A-10": natural order within a project. */
export function compareUnits(a: PortalUnitDto, b: PortalUnitDto): number {
  return (
    a.projectName.localeCompare(b.projectName, 'en', { sensitivity: 'base' }) ||
    a.unitNumber.localeCompare(b.unitNumber, 'en', { numeric: true, sensitivity: 'base' })
  );
}

@Injectable()
export class CustomerPortalService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get client() {
    return this.prismaService.$client;
  }

  private assertCustomer(actor: JwtPayload): void {
    if (actor.role !== 'CUSTOMER') {
      throw new ForbiddenException('This route is for customer accounts.');
    }
  }

  /** Resolve the caller's lead pointer or throw the lock-screen 403. */
  private async loadCustomer(
    tx: RlsTx,
    actor: JwtPayload,
  ): Promise<{ name: string; leadId: string }> {
    const user = await tx.user.findUnique({
      where: { id: actor.sub },
      select: { name: true, customerLeadId: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || user.customerLeadId === null) {
      const org = await tx.organization.findUnique({
        where: { id: actor.organizationId },
        select: { contactPhone: true },
      });
      throw new CodedForbiddenException(
        NOT_LINKED_CODE,
        'Your photos are not linked to your account yet. Please contact the project office.',
        { officePhone: org?.contactPhone ?? null },
      );
    }
    return { name: user.name, leadId: user.customerLeadId };
  }

  async me(actor: JwtPayload): Promise<PortalMeDto> {
    this.assertCustomer(actor);
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const { name, leadId } = await this.loadCustomer(tx, actor);

      const bookings = await tx.booking.findMany({
        where: { leadId, organizationId: actor.organizationId, status: 'APPROVED' },
        select: {
          unit: {
            select: {
              id: true,
              unitNumber: true,
              expectedHandoverDate: true,
              phase: { select: { project: { select: { id: true, name: true } } } },
            },
          },
        },
      });

      const byId = new Map(bookings.map((b) => [b.unit.id, b.unit] as const));
      const unitIds = [...byId.keys()];
      if (unitIds.length === 0) return { customerName: name, units: [] };

      const projectIds = [...new Set([...byId.values()].map((u) => u.phase.project.id))];
      const [counts, newest, milestoneRows] = await Promise.all([
        tx.progressPhoto.groupBy({
          by: ['unitId'],
          where: { unitId: { in: unitIds }, organizationId: actor.organizationId },
          _count: { _all: true },
        }),
        tx.progressPhoto.findMany({
          where: { unitId: { in: unitIds }, organizationId: actor.organizationId },
          orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
          distinct: ['unitId'],
          select: { unitId: true, phase: { select: { name: true } } },
        }),
        tx.projectMilestone.findMany({
          where: { projectId: { in: projectIds }, organizationId: actor.organizationId },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: { id: true, projectId: true, name: true, targetDate: true, completedAt: true },
        }),
      ]);
      const milestonesByProject = new Map<string, PortalMilestoneDto[]>();
      for (const m of milestoneRows) {
        const list = milestonesByProject.get(m.projectId) ?? [];
        list.push({
          id: m.id,
          name: m.name,
          targetDate: m.targetDate?.toISOString() ?? null,
          completedAt: m.completedAt?.toISOString() ?? null,
        });
        milestonesByProject.set(m.projectId, list);
      }
      const countByUnit = new Map(counts.map((c) => [c.unitId, c._count._all] as const));
      const phaseByUnit = new Map(newest.map((n) => [n.unitId, n.phase?.name ?? null] as const));

      const units = [...byId.values()]
        .map<PortalUnitDto>((u) => ({
          unitId: u.id,
          unitNumber: u.unitNumber,
          projectName: u.phase.project.name,
          projectId: u.phase.project.id,
          currentPhaseName: phaseByUnit.get(u.id) ?? null,
          photoCount: countByUnit.get(u.id) ?? 0,
          expectedHandoverDate: u.expectedHandoverDate?.toISOString() ?? null,
          milestones: milestonesByProject.get(u.phase.project.id) ?? [],
        }))
        .sort(compareUnits);
      return { customerName: name, units };
    });
  }

  async timeline(
    actor: JwtPayload,
    unitId: string,
    cursorRaw: string | undefined,
  ): Promise<TimelineResponseDto> {
    this.assertCustomer(actor);
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const { leadId } = await this.loadCustomer(tx, actor);
      const booking = await tx.booking.findFirst({
        where: { unitId, leadId, organizationId: actor.organizationId, status: 'APPROVED' },
        select: { id: true },
      });
      if (booking === null) throw new NotFoundException('Unit not found.');
      return readTimelinePage(tx, {
        unitId,
        organizationId: actor.organizationId,
        cursorRaw,
        // A buyer has no write arm on any table (spec D5), so canMutate is
        // false on every row. Passed explicitly to keep the wire shape
        // identical to the staff timeline.
        scope: { viewer: null, leadsProject: false },
      });
    });
  }
}
