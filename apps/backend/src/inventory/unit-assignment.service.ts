// Unit -> site ENGINEER assignment (2026-11-10).
//
// One villa has at most ONE assigned engineer; an ENGINEER can only read and
// photograph the villas assigned to them (RLS: unit_select_assigned_engineer +
// the narrowed ProgressPhoto arms). This service is the only writer of
// Unit.assignedEngineerId/assignedAt/assignedById.
//
// Rules (all ADMIN/OWNER only - assignment is an admin act, like provisioning
// the engineer):
//   - target must be a live ENGINEER in the actor's org;
//   - the engineer must sit on a team linked to the villa's project (else 409:
//     they would be assigned a villa they cannot otherwise reach);
//   - the Unit write and its audit rows share ONE transaction (plan A2/G-1);
//   - notifications are emitted AFTER commit, per recipient, best effort: a
//     failed push never un-assigns a villa.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { AssignUnitsDto, UnitRow } from '@shadhil/api-types';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import { isAdminClass } from '../users/roles';
import { UNIT_ROW_SELECT, toUnitRow } from './unit-row';
import { extrasFor, loadUnitUpdateExtras } from './unit-update-summary';

export const UNIT_ASSIGNED = 'progress.assigned';
export const UNIT_UNASSIGNED = 'progress.unassigned';

/** A unit as the assignment writer needs it. */
interface UnitForAssign {
  readonly id: string;
  readonly unitNumber: string;
  readonly assignedEngineerId: string | null;
  readonly phase: { readonly projectId: string; readonly project: { readonly name: string } };
}

/** One recipient's pending notification, grouped per (recipient, type). */
interface PendingNotice {
  readonly recipientId: string;
  readonly type: typeof UNIT_ASSIGNED | typeof UNIT_UNASSIGNED;
  readonly unitIds: readonly string[];
  readonly unitNumbers: readonly string[];
  readonly projectName: string;
}

export interface AssignUnitsResult {
  readonly assigned: number;
  readonly unassigned: number;
}

const UNIT_FOR_ASSIGN_SELECT = {
  id: true,
  unitNumber: true,
  assignedEngineerId: true,
  phase: { select: { projectId: true, project: { select: { name: true } } } },
} as const;

function villaLabel(numbers: readonly string[]): string {
  if (numbers.length === 1) return `Villa ${numbers[0]}`;
  const shown = numbers.slice(0, 3).join(', ');
  const rest = numbers.length - 3;
  return rest > 0
    ? `${numbers.length} villas (${shown} +${rest} more)`
    : `${numbers.length} villas (${shown})`;
}

/** Group per-unit transitions into one notice per (recipient, type). */
export function groupNotices(
  transitions: readonly { unit: UnitForAssign; from: string | null; to: string | null }[],
): PendingNotice[] {
  const buckets = new Map<
    string,
    { notice: Omit<PendingNotice, 'unitIds' | 'unitNumbers'>; ids: string[]; nums: string[] }
  >();
  const push = (recipientId: string, type: PendingNotice['type'], unit: UnitForAssign) => {
    const key = `${recipientId}|${type}|${unit.phase.projectId}`;
    const bucket = buckets.get(key) ?? {
      notice: { recipientId, type, projectName: unit.phase.project.name },
      ids: [],
      nums: [],
    };
    bucket.ids.push(unit.id);
    bucket.nums.push(unit.unitNumber);
    buckets.set(key, bucket);
  };
  for (const t of transitions) {
    if (t.from === t.to) continue;
    if (t.to !== null) push(t.to, UNIT_ASSIGNED, t.unit);
    if (t.from !== null) push(t.from, UNIT_UNASSIGNED, t.unit);
  }
  return [...buckets.values()].map((b) => ({ ...b.notice, unitIds: b.ids, unitNumbers: b.nums }));
}

@Injectable()
export class UnitAssignmentService {
  private readonly logger = new Logger(UnitAssignmentService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  private assertAdmin(actor: JwtPayload): void {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can assign villas to engineers (actor is ${actor.role}).`,
      );
    }
  }

  /** PATCH /inventory/units/:id/assignee - assign one villa, or unassign (null). */
  async assignEngineer(
    actor: JwtPayload,
    unitId: string,
    engineerId: string | null,
  ): Promise<UnitRow> {
    this.assertAdmin(actor);
    const notices = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const db = tx as unknown as PrismaClient;
      const unit = await db.unit.findFirst({
        where: { id: unitId, organizationId: actor.organizationId },
        select: UNIT_FOR_ASSIGN_SELECT,
      });
      if (unit === null) throw new NotFoundException(`Unit ${unitId} not found.`);
      if (engineerId !== null) {
        await this.assertEngineerEligible(db, actor, engineerId, [unit.phase.projectId]);
      }
      if (unit.assignedEngineerId === engineerId) return [] as PendingNotice[];
      await this.writeAssignments(db, actor, [unit], engineerId);
      return groupNotices([{ unit, from: unit.assignedEngineerId, to: engineerId }]);
    });
    await this.dispatch(actor, notices);
    return this.readRow(actor, unitId);
  }

  /** PUT /inventory/units/assign - replace one engineer's villa set within a project. */
  async assignUnits(actor: JwtPayload, dto: AssignUnitsDto): Promise<AssignUnitsResult> {
    this.assertAdmin(actor);
    const wanted = [...new Set(dto.unitIds)];
    const { notices, result } = await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const db = tx as unknown as PrismaClient;
        await this.assertEngineerEligible(db, actor, dto.engineerId, [dto.projectId]);
        const inProject = await db.unit.findMany({
          where: {
            organizationId: actor.organizationId,
            phase: { projectId: dto.projectId },
          },
          select: UNIT_FOR_ASSIGN_SELECT,
        });
        const byId = new Map(inProject.map((u) => [u.id, u]));
        const stray = wanted.filter((id) => !byId.has(id));
        if (stray.length > 0) {
          throw new BadRequestException(
            `${stray.length} unit id(s) do not belong to project ${dto.projectId}. ` +
              'Reload the villa list and try again.',
          );
        }
        const wantedSet = new Set(wanted);
        const toAdd = inProject.filter(
          (u) => wantedSet.has(u.id) && u.assignedEngineerId !== dto.engineerId,
        );
        const toRemove = inProject.filter(
          (u) => !wantedSet.has(u.id) && u.assignedEngineerId === dto.engineerId,
        );
        await this.writeAssignments(db, actor, toAdd, dto.engineerId);
        await this.writeAssignments(db, actor, toRemove, null);
        const transitions = [
          ...toAdd.map((unit) => ({
            unit,
            from: unit.assignedEngineerId,
            to: dto.engineerId as string | null,
          })),
          ...toRemove.map((unit) => ({
            unit,
            from: unit.assignedEngineerId,
            to: null as string | null,
          })),
        ];
        return {
          notices: groupNotices(transitions),
          result: { assigned: toAdd.length, unassigned: toRemove.length },
        };
      },
    );
    await this.dispatch(actor, notices);
    return result;
  }

  /** Live ENGINEER in the org, on a team linked to every project involved. */
  private async assertEngineerEligible(
    db: PrismaClient,
    actor: JwtPayload,
    engineerId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    const engineer = await db.user.findFirst({
      where: { id: engineerId, organizationId: actor.organizationId, deletedAt: null },
      select: { id: true, role: true, name: true },
    });
    if (engineer === null) {
      throw new NotFoundException(`User ${engineerId} not found.`);
    }
    if (engineer.role !== 'ENGINEER') {
      throw new BadRequestException(
        `${engineer.name} is a ${engineer.role}, not an ENGINEER. Only site engineers can be assigned villas.`,
      );
    }
    for (const projectId of projectIds) {
      const linked = await db.projectTeam.count({
        where: {
          projectId,
          organizationId: actor.organizationId,
          team: { deletedAt: null, teamMembers: { some: { userId: engineerId } } },
        },
      });
      if (linked === 0) {
        throw new ConflictException(
          `${engineer.name} is not on a team linked to this project. ` +
            'Add them to a project team first, then assign villas.',
        );
      }
    }
  }

  /** Unit update + audit rows, inside the caller's transaction. */
  private async writeAssignments(
    db: PrismaClient,
    actor: JwtPayload,
    units: readonly UnitForAssign[],
    engineerId: string | null,
  ): Promise<void> {
    if (units.length === 0) return;
    await db.unit.updateMany({
      where: { id: { in: units.map((u) => u.id) }, organizationId: actor.organizationId },
      data: {
        assignedEngineerId: engineerId,
        assignedAt: engineerId === null ? null : new Date(),
        assignedById: engineerId === null ? null : actor.sub,
      },
    });
    await db.auditLog.createMany({
      data: units.map((u) => ({
        userId: actor.sub,
        organizationId: actor.organizationId,
        action: 'inventory.unit.assign',
        entityType: 'Unit',
        entityId: u.id,
        before: { assignedEngineerId: u.assignedEngineerId },
        after: { assignedEngineerId: engineerId },
        reason: `Unit ${u.unitNumber} ${engineerId === null ? 'unassigned' : 'assigned'} by ${actor.email} (${actor.role})`,
      })),
    });
  }

  /** Post-commit, per-recipient, best effort. */
  private async dispatch(actor: JwtPayload, notices: readonly PendingNotice[]): Promise<void> {
    for (const n of notices) {
      const label = villaLabel(n.unitNumbers);
      const assigned = n.type === UNIT_ASSIGNED;
      try {
        await this.notifications.emit(n.recipientId, {
          type: n.type,
          title: assigned ? `${label} assigned to you` : `${label} reassigned`,
          body: assigned
            ? `${n.projectName}: you can now post site updates for ${label}.`
            : `${n.projectName}: ${label} is no longer assigned to you.`,
          unitId: n.unitIds[0],
          organizationId: actor.organizationId,
        });
      } catch (err) {
        this.logger.error(
          `Failed to emit ${n.type} to ${n.recipientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async readRow(actor: JwtPayload, unitId: string): Promise<UnitRow> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const unit = await (tx as unknown as PrismaClient).unit.findFirst({
        where: { id: unitId, organizationId: actor.organizationId },
        select: UNIT_ROW_SELECT,
      });
      if (unit === null) throw new NotFoundException(`Unit ${unitId} not found.`);
      // Same shape as the detail read: the stage lives in the summary now, so
      // this row would otherwise come back with no stage at all.
      const extras = await loadUnitUpdateExtras(tx as unknown as PrismaClient, [unit.id]);
      return toUnitRow(unit, true, extrasFor(extras, unit.id));
    });
  }
}
