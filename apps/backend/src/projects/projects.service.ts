// Projects service - CRUD on the Project registry (T-ProjectSwitch, 2026-09-05).
//
// The Project table is the REAL project registry (Phase 2 of real project
// switching). Roles:
//   list   - every authenticated role (the switcher needs it; RLS policy
//            project_select_any_authenticated allows all app roles).
//   create - ADMIN class (OWNER travels as ADMIN at the RLS layer per the
//            locked Round-21 downcast; JWT keeps the real role, so the
//            service guard checks the JWT role, not the RLS role).
//   update - ADMIN class. Slug is immutable. Owner-only NAME changes are
//            NOT a thing (admin may rename per client decision); the JWT
//            guard here is role ∈ {ADMIN, OWNER}.
//   remove - OWNER only (JWT role check; the RLS layer cannot distinguish
//            OWNER from ADMIN because withRlsContext downcasts, so the
//            precise "owner-only delete" wall lives HERE, and the DB
//            policy (ADMIN-level) is the second wall).
//
// Delete guard: a project with Bookings under its phases/units is refused
// (409 ConflictObjectException). Bookings are irreversible commercial
// records; Lead.projectId SetNulls by design so leads survive a delete,
// but bookings must not be orphaned (their FK to Unit is Restrict).
//
// Every write emits an AuditLog row inside the same withRlsContext
// transaction (mirrors leads.service.ts createInTransaction).
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreateProjectDto,
  ProjectListResult,
  ProjectRow,
  PrismaClient,
  UpdateProjectDto,
} from './projects.types';

import { PrismaService } from '../prisma/prisma.module';

export type { ProjectRow, ProjectListResult } from './projects.types';

/** Admin-class roles for create/update (JWT-level check). */
const ADMIN_CLASS = new Set(['ADMIN', 'OWNER']);

/**
 * Derive a URL-safe slug from a project name. Exported for direct unit
 * tests (repo rule: pure helpers are named exports, tested without Nest).
 */
export function slugifyProjectName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'project';
}

function isAdminClass(role: string): boolean {
  return ADMIN_CLASS.has(role);
}

@Injectable()
export class ProjectsService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined
  // (same as teams.service.ts / leads.service.ts).
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * List every project, oldest first. The FIRST row is the default active
   * project (seed creates Shadhil Metro Heights first). No membership
   * narrowing: the registry is shared operational data for all roles.
   */
  async list(actor: JwtPayload): Promise<ProjectListResult> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.project.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              slug: true,
              name: true,
              address: true,
              reraNumber: true,
              cmdaNumber: true,
              createdAt: true,
            },
          }),
          tx.project.count(),
        ]);
        return {
          total,
          projects: rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            name: r.name,
            address: r.address,
            reraNumber: r.reraNumber,
            cmdaNumber: r.cmdaNumber,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      },
    );
  }

  /** Create a project. ADMIN/OWNER only. Slug derived from name. */
  async create(actor: JwtPayload, dto: CreateProjectDto): Promise<ProjectRow> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can create projects.',
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const slug = await this.uniqueSlug(
          tx as unknown as PrismaClient,
          slugifyProjectName(dto.name),
        );
        const created = await tx.project.create({
          data: {
            name: dto.name,
            slug,
            address: dto.address ?? null,
            reraNumber: dto.reraNumber ?? null,
            cmdaNumber: dto.cmdaNumber ?? null,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.create',
            entityType: 'Project',
            entityId: created.id,
            after: {
              name: created.name,
              slug: created.slug,
              reraNumber: created.reraNumber,
              cmdaNumber: created.cmdaNumber,
            },
            reason: `project.create by ${actor.email} (${actor.role})`,
          },
        });
        return this.toRow(created);
      },
    );
  }

  /**
   * Update name / compliance fields. ADMIN/OWNER only. Slug is immutable
   * (stable identity for the [projectId] route segment).
   */
  async update(
    actor: JwtPayload,
    id: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectRow> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can edit projects.',
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await tx.project.findUnique({ where: { id } });
        if (existing === null) {
          throw new NotFoundException(`Project ${id} not found.`);
        }
        const updated = await tx.project.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.address !== undefined ? { address: dto.address ?? null } : {}),
            ...(dto.reraNumber !== undefined
              ? { reraNumber: dto.reraNumber ?? null }
              : {}),
            ...(dto.cmdaNumber !== undefined
              ? { cmdaNumber: dto.cmdaNumber ?? null }
              : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.update',
            entityType: 'Project',
            entityId: id,
            before: {
              name: existing.name,
              address: existing.address,
              reraNumber: existing.reraNumber,
              cmdaNumber: existing.cmdaNumber,
            },
            after: {
              name: updated.name,
              address: updated.address,
              reraNumber: updated.reraNumber,
              cmdaNumber: updated.cmdaNumber,
            },
            reason: `project.update by ${actor.email} (${actor.role})`,
          },
        });
        return this.toRow(updated);
      },
    );
  }

  /**
   * Delete a project. OWNER only (JWT guard - the RLS layer cannot see
   * the real role). Refuses when Bookings exist under the project's
   * units (409) - bookings are irreversible commercial records.
   * Lead.projectId SetNulls via the FK, so leads are NOT a blocker.
   */
  async remove(actor: JwtPayload, id: string): Promise<{ id: string }> {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Only the OWNER can delete projects.');
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const existing = await tx.project.findUnique({
          where: { id },
          include: { _count: { select: { leads: true } } },
        });
        if (existing === null) {
          throw new NotFoundException(`Project ${id} not found.`);
        }
        // Booking count via the project → phases → units → bookings path.
        const bookingCount = await tx.booking.count({
          where: { unit: { phase: { projectId: id } } },
        });
        if (bookingCount > 0) {
          throw new ConflictException(
            `Project "${existing.name}" still has ${bookingCount} booking(s). ` +
              'Move or delete the bookings before deleting the project.',
          );
        }
        await tx.project.delete({ where: { id } });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.delete',
            entityType: 'Project',
            entityId: id,
            before: {
              name: existing.name,
              slug: existing.slug,
              leadCount: existing._count.leads,
            },
            reason: `project.delete by ${actor.email} (${actor.role})`,
          },
        });
        return { id };
      },
    );
  }

  /** Slug uniqueness with a -2 / -3 suffix on collision (create only). */
  private async uniqueSlug(
    // The withRlsContext tx is the Omit<>ed client (no lifecycle
    // methods) - the accepted shape per the leads.service.ts convention.
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
    >,
    base: string,
  ): Promise<string> {
    let candidate = base;
    let n = 1;
    // Bounded loop: slug has a 64-char column limit in practice; the
    // suffix keeps us well under it for realistic collision counts.
    while (n < 100) {
      const clash = await tx.project.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (clash === null) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
    throw new BadRequestException(
      `Could not derive a unique slug for "${base}".`,
    );
  }

  private toRow(row: {
    id: string;
    slug: string;
    name: string;
    address: string;
    reraNumber: string | null;
    cmdaNumber: string | null;
    createdAt: Date;
  }): ProjectRow {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      address: row.address,
      reraNumber: row.reraNumber,
      cmdaNumber: row.cmdaNumber,
      createdAt: row.createdAt.toISOString(),
    };
  }
}