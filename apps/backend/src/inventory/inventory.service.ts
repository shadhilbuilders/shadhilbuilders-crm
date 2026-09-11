// Inventory service - REST surface for the villa/unit availability grid.
//
// Scoping (per JWT): every read/write flows through withRlsContext.
// Unit/Phase are RLS-gated (migration 2026_09_10_inventory_rls): SELECT
// is open to every authenticated role (the grid is shared operational
// data); INSERT/UPDATE/DELETE are ADMIN-class (DESIGN.md §4 "Edit
// projects / units / inventory" = ADMIN/OWNER only). The service guard
// checks the JWT role (isAdminClass) - the RLS policy is the second wall.
//
// Write paths (all inside `withRlsContext`):
//   - create: new Unit in the given phase. Audit row.
//   - update: partial edit (unitNumber/bhk/facing/sqft/price/status).
//     Audit row with before/after.
//
// Reads:
//   - list: role-scoped grid with project/phase/bhk/facing/status filters
//     + server pagination.
//   - findOne: unit detail (unit + phase + project + its bookings).
//   - phases: phases for a project (filter + detail).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreatePhaseDto,
  CreateProjectOptionDto,
  CreateUnitDto,
  PhaseRow,
  ProjectOptionFilterDto,
  ProjectOptionRow,
  UnitFilterDto,
  UnitListResult,
  UnitRow,
  UpdatePhaseDto,
  UpdateUnitDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import {
  canManageProjectMembers,
  isAdminClass,
} from '../users/roles';

/**
 * Wire shape returned by every endpoint. Matches the api-types
 * UnitRowSchema; the web app imports this shape in
 * apps/web/src/hooks/queries/inventory.ts (useInventoryUnits).
 */
export type { UnitRow, UnitListResult, PhaseRow };

@Injectable()
export class InventoryService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/inventory/units?projectId=&phaseId=&bhk=&facing=&status=
   * - role-scoped grid. Every authenticated role can read (the RLS
   * SELECT policy is open); the service narrows by the filters.
   */
  async list(
    actor: JwtPayload,
    dto: UnitFilterDto,
  ): Promise<UnitListResult> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (dto.projectId !== undefined) {
          where['phase'] = { projectId: dto.projectId };
        }
        if (dto.phaseId !== undefined) where['phaseId'] = dto.phaseId;
        if (dto.bhk !== undefined) where['bhk'] = dto.bhk;
        if (dto.facing !== undefined) {
          where['facing'] = { equals: dto.facing, mode: 'insensitive' };
        }
        if (dto.status !== undefined) {
          where['status'] = Array.isArray(dto.status)
            ? { in: dto.status }
            : dto.status;
        }

        const [rows, total] = await Promise.all([
          (tx as unknown as PrismaClient).unit.findMany({
            where,
            take: dto.limit,
            skip: dto.offset,
            orderBy: [{ phaseId: 'asc' }, { unitNumber: 'asc' }],
            select: {
              id: true,
              phaseId: true,
              unitNumber: true,
              bhk: true,
              facing: true,
              sqft: true,
              price: true,
              status: true,
              createdAt: true,
              phase: {
                select: { name: true, projectId: true, project: { select: { name: true } } },
              },
            },
          }),
          (tx as unknown as PrismaClient).unit.count({ where }),
        ]);

        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            phaseId: r.phaseId,
            phaseName: r.phase.name,
            projectId: r.phase.projectId,
            projectName: r.phase.project.name,
            unitNumber: r.unitNumber,
            bhk: r.bhk,
            facing: r.facing,
            sqft: r.sqft,
            price: r.price.toString(),
            status: r.status,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      },
    );
  }

  /**
   * GET /api/inventory/units/:id - unit detail (unit + phase + project
   * + its bookings). Every authenticated role can read.
   */
  async findOne(actor: JwtPayload, unitId: string): Promise<UnitRow> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const unit = await (tx as unknown as PrismaClient).unit.findUnique({
          where: { id: unitId },
          select: {
            id: true,
            phaseId: true,
            unitNumber: true,
            bhk: true,
            facing: true,
            sqft: true,
            price: true,
            status: true,
            createdAt: true,
            phase: {
              select: { name: true, projectId: true, project: { select: { name: true } } },
            },
          },
        });
        if (unit === null) {
          throw new NotFoundException(`Unit ${unitId} not found`);
        }
        return {
          id: unit.id,
          phaseId: unit.phaseId,
          phaseName: unit.phase.name,
          projectId: unit.phase.projectId,
          projectName: unit.phase.project.name,
          unitNumber: unit.unitNumber,
          bhk: unit.bhk,
          facing: unit.facing,
          sqft: unit.sqft,
          price: unit.price.toString(),
          status: unit.status,
          createdAt: unit.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * GET /api/inventory/phases?projectId= - phases for a project, each
   * with its unit count (for the filter + detail panel).
   */
  async phases(actor: JwtPayload, projectId?: string): Promise<PhaseRow[]> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (projectId !== undefined) where['projectId'] = projectId;
        const phases = await (tx as unknown as PrismaClient).phase.findMany({
          where,
          orderBy: { name: 'asc' },
          select: {
            id: true,
            projectId: true,
            name: true,
            _count: { select: { units: true } },
          },
        });
        return phases.map((p) => ({
          id: p.id,
          projectId: p.projectId,
          name: p.name,
          unitCount: p._count.units,
        }));
      },
    );
  }

  /**
   * POST /api/inventory/phases - create a phase in a project.
   * MANAGER/ADMIN/OWNER only (DESIGN.md §4 "Edit projects / units /
   * inventory" + the manager-write widening). Audit row records the
   * actor + phase.
   */
  async createPhase(
    actor: JwtPayload,
    dto: CreatePhaseDto,
  ): Promise<PhaseRow> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException(
        `Only MANAGER/ADMIN/OWNER can create phases (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const project = await (tx as unknown as PrismaClient).project.findUnique({
          where: { id: dto.projectId },
          select: { id: true },
        });
        if (project === null) {
          throw new NotFoundException(`Project ${dto.projectId} not found`);
        }
        const created = await (tx as unknown as PrismaClient).phase.create({
          data: { projectId: dto.projectId, name: dto.name },
          select: { id: true, projectId: true, name: true },
        });
        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.phase.create',
            entityType: 'Phase',
            entityId: created.id,
            after: { projectId: created.projectId, name: created.name },
            reason: `Phase ${created.name} created by ${actor.email} (${actor.role})`,
          },
        });
        return { id: created.id, projectId: created.projectId, name: created.name, unitCount: 0 };
      },
    );
  }

  /**
   * PATCH /api/inventory/phases/:id - rename a phase. MANAGER/ADMIN/OWNER
   * only. Audit row with before/after.
   */
  async updatePhase(
    actor: JwtPayload,
    phaseId: string,
    dto: UpdatePhaseDto,
  ): Promise<PhaseRow> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException(
        `Only MANAGER/ADMIN/OWNER can update phases (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).phase.findUnique({
          where: { id: phaseId },
          select: { id: true, projectId: true, name: true },
        });
        if (existing === null) {
          throw new NotFoundException(`Phase ${phaseId} not found`);
        }
        const data: Record<string, unknown> = {};
        if (dto.name !== undefined) data['name'] = dto.name;
        const updated = await (tx as unknown as PrismaClient).phase.update({
          where: { id: phaseId },
          data,
          select: { id: true, projectId: true, name: true },
        });
        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.phase.update',
            entityType: 'Phase',
            entityId: phaseId,
            before: { name: existing.name },
            after: { name: updated.name },
            reason: `Phase ${existing.name} renamed to ${updated.name} by ${actor.email} (${actor.role})`,
          },
        });
        return { id: updated.id, projectId: updated.projectId, name: updated.name, unitCount: 0 };
      },
    );
  }

  /**
   * DELETE /api/inventory/phases/:id - remove a phase. MANAGER/ADMIN/OWNER
   * only. Refuses (409) when the phase still has units - the Unit FK is
   * Cascade, so a delete would silently drop every unit; the explicit
   * guard gives the operator a readable reason. Audit row records the
   * deleted phase.
   */
  async deletePhase(
    actor: JwtPayload,
    phaseId: string,
  ): Promise<{ id: string }> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException(
        `Only MANAGER/ADMIN/OWNER can delete phases (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).phase.findUnique({
          where: { id: phaseId },
          select: { id: true, projectId: true, name: true },
        });
        if (existing === null) {
          throw new NotFoundException(`Phase ${phaseId} not found`);
        }
        const unitCount = await (tx as unknown as PrismaClient).unit.count({
          where: { phaseId },
        });
        if (unitCount > 0) {
          throw new ConflictException(
            `Phase "${existing.name}" still has ${unitCount} unit(s). ` +
              'Move or delete the units before deleting the phase.',
          );
        }
        await (tx as unknown as PrismaClient).phase.delete({
          where: { id: phaseId },
        });
        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.phase.delete',
            entityType: 'Phase',
            entityId: phaseId,
            before: { projectId: existing.projectId, name: existing.name },
            reason: `Phase ${existing.name} deleted by ${actor.email} (${actor.role})`,
          },
        });
        return { id: phaseId };
      },
    );
  }

  /**
   * GET /api/inventory/options?projectId=&type= - the project's option
   * sets (facing/BHK). Every authenticated role can read (the pickers
   * load them). `type` optionally narrows to a single set.
   */
  async options(
    actor: JwtPayload,
    dto: ProjectOptionFilterDto,
  ): Promise<ProjectOptionRow[]> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const rows = await (tx as unknown as PrismaClient).projectOption.findMany({
          where: {
            projectId: dto.projectId,
            ...(dto.type !== undefined ? { type: dto.type } : {}),
          },
          orderBy: [{ type: 'asc' }, { value: 'asc' }],
          select: {
            id: true,
            projectId: true,
            type: true,
            value: true,
            createdAt: true,
          },
        });
        // Real unit count per option: how many units in this project use
        // the value. Facing is a string field; BHK is stored as an int.
        const counts = await Promise.all(
          rows.map(async (r) => {
            const where =
              r.type === 'FACING'
                ? { facing: r.value, phase: { projectId: r.projectId } }
                : { bhk: Number(r.value), phase: { projectId: r.projectId } };
            return (tx as unknown as PrismaClient).unit.count({ where });
          }),
        );
        return rows.map((r, i) => ({
          id: r.id,
          projectId: r.projectId,
          type: r.type,
          value: r.value,
          unitCount: counts[i],
          createdAt: r.createdAt.toISOString(),
        }));
      },
    );
  }

  /**
   * POST /api/inventory/options - add a value to a project's option set.
   * MANAGER/ADMIN/OWNER only. The unique (projectId, type, value) index
   * guards duplicates (Prisma raises, surfaced as a readable 409 below).
   * Audit row records the actor + option.
   */
  async createOption(
    actor: JwtPayload,
    dto: CreateProjectOptionDto,
  ): Promise<ProjectOptionRow> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException(
        `Only MANAGER/ADMIN/OWNER can add options (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const project = await (tx as unknown as PrismaClient).project.findUnique({
          where: { id: dto.projectId },
          select: { id: true },
        });
        if (project === null) {
          throw new NotFoundException(`Project ${dto.projectId} not found`);
        }
        let created;
        try {
          created = await (tx as unknown as PrismaClient).projectOption.create({
            data: { projectId: dto.projectId, type: dto.type, value: dto.value },
            select: { id: true, projectId: true, type: true, value: true, createdAt: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new ConflictException(
              `Option "${dto.value}" already exists for this project`,
            );
          }
          throw err;
        }
        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.option.create',
            entityType: 'ProjectOption',
            entityId: created.id,
            after: { projectId: created.projectId, type: created.type, value: created.value },
            reason: `Option ${created.type}:${created.value} added by ${actor.email} (${actor.role})`,
          },
        });
        return {
          id: created.id,
          projectId: created.projectId,
          type: created.type,
          value: created.value,
          unitCount: 0,
          createdAt: created.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * DELETE /api/inventory/options/:id - remove a value from a project's
   * option set. MANAGER/ADMIN/OWNER only. Refuses (409) when the value is
   * in use by a unit in the project (facing matches Unit.facing; BHK
   * matches Unit.bhk stringified) - the operator must reassign or delete
   * those units first, otherwise the picker would offer a value that no
   * longer matches any stored unit. Audit row records the deleted option.
   */
  async deleteOption(
    actor: JwtPayload,
    optionId: string,
  ): Promise<{ id: string }> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException(
        `Only MANAGER/ADMIN/OWNER can delete options (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).projectOption.findUnique({
          where: { id: optionId },
          select: { id: true, projectId: true, type: true, value: true },
        });
        if (existing === null) {
          throw new NotFoundException(`ProjectOption ${optionId} not found`);
        }
        if (existing.type === 'FACING') {
          const inUse = await (tx as unknown as PrismaClient).unit.count({
            where: { facing: existing.value, phase: { projectId: existing.projectId } },
          });
          if (inUse > 0) {
            throw new ConflictException(
              `Facing "${existing.value}" is used by ${inUse} unit(s) in this project. ` +
                'Reassign them before removing this option.',
            );
          }
        } else {
          const inUse = await (tx as unknown as PrismaClient).unit.count({
            where: { bhk: Number(existing.value), phase: { projectId: existing.projectId } },
          });
          if (inUse > 0) {
            throw new ConflictException(
              `BHK ${existing.value} is used by ${inUse} unit(s) in this project. ` +
                'Reassign them before removing this option.',
            );
          }
        }
        await (tx as unknown as PrismaClient).projectOption.delete({
          where: { id: optionId },
        });
        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.option.delete',
            entityType: 'ProjectOption',
            entityId: optionId,
            before: {
              projectId: existing.projectId,
              type: existing.type,
              value: existing.value,
            },
            reason: `Option ${existing.type}:${existing.value} removed by ${actor.email} (${actor.role})`,
          },
        });
        return { id: optionId };
      },
    );
  }

  /**
   * POST /api/inventory/units - create a new unit. ADMIN/OWNER only
   * (DESIGN.md §4). Audit row records the actor + unit details.
   */
  async create(actor: JwtPayload, dto: CreateUnitDto): Promise<UnitRow> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can create inventory units (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const phase = await (tx as unknown as PrismaClient).phase.findUnique({
          where: { id: dto.phaseId },
          select: { id: true, name: true, projectId: true, project: { select: { name: true } } },
        });
        if (phase === null) {
          throw new NotFoundException(`Phase ${dto.phaseId} not found`);
        }

        const created = await (tx as unknown as PrismaClient).unit.create({
          data: {
            phaseId: dto.phaseId,
            unitNumber: dto.unitNumber,
            bhk: dto.bhk,
            facing: dto.facing ?? null,
            sqft: dto.sqft ?? null,
            // Prisma Decimal - pass as a string to avoid float drift.
            price: dto.price.toFixed(2),
            status: dto.status ?? 'AVAILABLE',
          },
          select: {
            id: true,
            phaseId: true,
            unitNumber: true,
            bhk: true,
            facing: true,
            sqft: true,
            price: true,
            status: true,
            createdAt: true,
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.unit.create',
            entityType: 'Unit',
            entityId: created.id,
            after: {
              phaseId: created.phaseId,
              unitNumber: created.unitNumber,
              bhk: created.bhk,
              price: created.price.toString(),
              status: created.status,
            },
            reason: `Unit ${created.unitNumber} created by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: created.id,
          phaseId: created.phaseId,
          phaseName: phase.name,
          projectId: phase.projectId,
          projectName: phase.project.name,
          unitNumber: created.unitNumber,
          bhk: created.bhk,
          facing: created.facing,
          sqft: created.sqft,
          price: created.price.toString(),
          status: created.status,
          createdAt: created.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * PATCH /api/inventory/units/:id - partial update. ADMIN/OWNER only.
   * Audit row with before/after.
   */
  async update(
    actor: JwtPayload,
    unitId: string,
    dto: UpdateUnitDto,
  ): Promise<UnitRow> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can update inventory units (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).unit.findUnique({
          where: { id: unitId },
          select: {
            id: true,
            phaseId: true,
            unitNumber: true,
            bhk: true,
            facing: true,
            sqft: true,
            price: true,
            status: true,
            createdAt: true,
            phase: {
              select: { name: true, projectId: true, project: { select: { name: true } } },
            },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Unit ${unitId} not found`);
        }

        const data: Record<string, unknown> = {};
        if (dto.unitNumber !== undefined) data['unitNumber'] = dto.unitNumber;
        if (dto.bhk !== undefined) data['bhk'] = dto.bhk;
        if (dto.facing !== undefined) data['facing'] = dto.facing;
        if (dto.sqft !== undefined) data['sqft'] = dto.sqft;
        if (dto.price !== undefined) data['price'] = dto.price.toFixed(2);
        if (dto.status !== undefined) data['status'] = dto.status;

        const updated = await (tx as unknown as PrismaClient).unit.update({
          where: { id: unitId },
          data,
          select: {
            id: true,
            phaseId: true,
            unitNumber: true,
            bhk: true,
            facing: true,
            sqft: true,
            price: true,
            status: true,
            createdAt: true,
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.unit.update',
            entityType: 'Unit',
            entityId: updated.id,
            before: {
              unitNumber: existing.unitNumber,
              bhk: existing.bhk,
              facing: existing.facing,
              sqft: existing.sqft,
              price: existing.price.toString(),
              status: existing.status,
            },
            after: {
              unitNumber: updated.unitNumber,
              bhk: updated.bhk,
              facing: updated.facing,
              sqft: updated.sqft,
              price: updated.price.toString(),
              status: updated.status,
            },
            reason: `Unit ${updated.unitNumber} updated by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: updated.id,
          phaseId: updated.phaseId,
          phaseName: existing.phase.name,
          projectId: existing.phase.projectId,
          projectName: existing.phase.project.name,
          unitNumber: updated.unitNumber,
          bhk: updated.bhk,
          facing: updated.facing,
          sqft: updated.sqft,
          price: updated.price.toString(),
          status: updated.status,
          createdAt: updated.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * DELETE /api/inventory/units/:id - remove a unit. ADMIN/OWNER only.
   * Refuses (409) when the unit has any booking - the Booking FK is
   * Restrict, so a delete would fail at the DB anyway; the explicit
   * guard gives the operator a readable reason. Audit row records the
   * deleted unit's details (the row is gone after this tx).
   */
  async delete(actor: JwtPayload, unitId: string): Promise<{ id: string }> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        `Only ADMIN/OWNER can delete inventory units (actor is ${actor.role})`,
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).unit.findUnique({
          where: { id: unitId },
          select: {
            id: true,
            phaseId: true,
            unitNumber: true,
            bhk: true,
            facing: true,
            sqft: true,
            price: true,
            status: true,
            createdAt: true,
            phase: { select: { name: true } },
          },
        });
        if (existing === null) {
          throw new NotFoundException(`Unit ${unitId} not found`);
        }

        const bookingCount = await (tx as unknown as PrismaClient).booking.count({
          where: { unitId },
        });
        if (bookingCount > 0) {
          throw new ConflictException(
            `Unit ${existing.unitNumber} has ${bookingCount} booking(s). ` +
              'Move or delete the bookings before deleting the unit.',
          );
        }

        await (tx as unknown as PrismaClient).unit.delete({
          where: { id: unitId },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'inventory.unit.delete',
            entityType: 'Unit',
            entityId: unitId,
            before: {
              phaseId: existing.phaseId,
              phaseName: existing.phase.name,
              unitNumber: existing.unitNumber,
              bhk: existing.bhk,
              facing: existing.facing,
              sqft: existing.sqft,
              price: existing.price.toString(),
              status: existing.status,
            },
            reason: `Unit ${existing.unitNumber} deleted by ${actor.email} (${actor.role})`,
          },
        });

        return { id: unitId };
      },
    );
  }
}
