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
import { withRlsContext, rlsContextFrom, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  CreateProjectDto,
  LinkProjectMemberDto,
  ProjectFilterDto,
  ProjectListResult,
  ProjectMemberRow,
  ProjectRow,
  UpdateProjectDto,
} from './projects.types';

import { PrismaService } from '../prisma/prisma.module';
import {
  canManageProjectMembers,
  isAdminClass,
} from '../users/roles';

export type { ProjectRow, ProjectListResult, ProjectMemberRow } from './projects.types';

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
   *
   * Optional `filter` drives server-side search + pagination (mirrors the
   * users list). When omitted, returns the FULL registry (backward-compatible;
   * the sidebar switcher calls with no params).
   */
  async list(
    actor: JwtPayload,
    filter: ProjectFilterDto = {},
  ): Promise<ProjectListResult> {
    if (filter.limit === undefined || filter.offset === undefined) {
      // Backward-compatible full-registry path (switcher, no params).
      return this.listAll(actor);
    }
    // Server-side search (mirrors leads/users): case-insensitive match on
    // name or slug (a project has no email), debounced at the UI.
    const where: { deletedAt: null; OR?: Array<Record<string, unknown>> } = {
      deletedAt: null,
    };
    if (filter.search !== undefined && filter.search.length > 0) {
      where.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { slug: { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    // Server-source pagination: skip/take from limit/offset (T-PROJ-SRVPG).
    const [rows, total] = await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      (tx) =>
        Promise.all([
          tx.project.findMany({
            where,
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
            skip: filter.offset,
            take: filter.limit,
          }),
          tx.project.count({ where }),
        ]),
    );
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
  }

  /** Full-registry path (no filter): every active project, oldest first. */
  private async listAll(actor: JwtPayload): Promise<ProjectListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.project.findMany({
            // T-SOFT-DELETE: only active projects appear in the registry/switcher.
            where: { deletedAt: null },
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
          tx.project.count({ where: { deletedAt: null } }),
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

  /**
   * Resolve a project by slug within the actor's org. This backs the
   * slug-based URL scheme: the project layout receives `projectSlug` from
   * the URL and resolves it to the project id (which the page then uses
   * for id-keyed hooks/APIs).
   *
   * Scoped to the actor's organization via their JWT `organizationId`,
   * combined with the `@@unique([organizationId, slug])` index. RLS is a
   * second wall. Returns null when the project is missing or soft-deleted.
   */
  async findBySlug(
    actor: JwtPayload,
    slug: string,
  ): Promise<{ id: string; slug: string; name: string } | null> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const row = await tx.project.findFirst({
        where: {
          organizationId: actor.organizationId,
          slug,
          deletedAt: null,
        },
        select: { id: true, slug: true, name: true },
      });
      return row ?? null;
    });
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
      rlsContextFrom(actor),
      async (tx) => {
        const slug = await this.uniqueSlug(
          tx as unknown as PrismaClient,
          slugifyProjectName(dto.name),
          actor.organizationId,
        );
        const created = await tx.project.create({
          data: {
            name: dto.name,
            slug,
            address: dto.address ?? null,
            reraNumber: dto.reraNumber ?? null,
            cmdaNumber: dto.cmdaNumber ?? null,
            organizationId: actor.organizationId,
          },
        });
        // Auto-seed the default facing/BHK option sets so a new project's
        // inventory pickers are immediately usable (the values are still
        // editable/removable later on the phases page).
        await tx.projectOption.createMany({
          data: [
            { projectId: created.id, type: 'FACING', value: 'North', organizationId: actor.organizationId },
            { projectId: created.id, type: 'FACING', value: 'South', organizationId: actor.organizationId },
            { projectId: created.id, type: 'FACING', value: 'East', organizationId: actor.organizationId },
            { projectId: created.id, type: 'FACING', value: 'West', organizationId: actor.organizationId },
            { projectId: created.id, type: 'BHK', value: '1', organizationId: actor.organizationId },
            { projectId: created.id, type: 'BHK', value: '2', organizationId: actor.organizationId },
            { projectId: created.id, type: 'BHK', value: '3', organizationId: actor.organizationId },
            { projectId: created.id, type: 'BHK', value: '4', organizationId: actor.organizationId },
            { projectId: created.id, type: 'BHK', value: '5', organizationId: actor.organizationId },
          ],
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.create',
            organizationId: actor.organizationId,
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
      rlsContextFrom(actor),
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
            organizationId: actor.organizationId,
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
   * Delete a project (SOFT delete, autoplan 2026-09-09). ADMIN + OWNER only.
   * Sets Project.deletedAt instead of DELETE: the project + its phases/units
   * stay in the DB (audit/history preserved) but it's hidden from the
   * registry, switcher, and per-project staff page. Refuses when Bookings
   * exist under the project's units (409 - commercial records preserved).
   */
  async remove(actor: JwtPayload, id: string): Promise<{ id: string }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER') {
      throw new ForbiddenException('Only ADMIN or OWNER can delete projects.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
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
        // Soft delete: stamp deletedAt (keep phases/units/leads in the DB).
        await tx.project.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.delete',
            organizationId: actor.organizationId,
            entityType: 'Project',
            entityId: id,
            before: {
              name: existing.name,
              slug: existing.slug,
              leadCount: existing._count.leads,
            },
            reason: `project.delete (soft) by ${actor.email} (${actor.role})`,
          },
        });
        return { id };
      },
    );
  }

  /**
   * POST /api/projects/:id/members - link an existing user to a project.
   * ADMIN/OWNER only. The per-project role defaults to the user's current
   * role; the caller may not override it here (role is set from User.role so
   * a SALES_EXEC linked to two projects is a SALES_EXEC on both — per-project
   * role overrides are out of scope for v1).
   */
  async addMember(
    actor: JwtPayload,
    projectId: string,
    dto: LinkProjectMemberDto,
  ): Promise<ProjectMemberRow> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException('Only MANAGER, ADMIN or OWNER can link members.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const project = await tx.project.findUnique({
          where: { id: projectId },
        });
        if (project === null) {
          throw new NotFoundException(`Project ${projectId} not found.`);
        }
        const user = await tx.user.findUnique({
          where: { id: dto.userId },
          select: { id: true, name: true, email: true, role: true },
        });
        if (user === null) {
          throw new NotFoundException(`User ${dto.userId} not found.`);
        }
        const member = await tx.projectMember.upsert({
          where: {
            projectId_userId: { projectId, userId: dto.userId },
          },
          update: { role: user.role },
          create: {
            projectId,
            userId: dto.userId,
            role: user.role,
            organizationId: actor.organizationId,
          },
        });
        // Provenance: an EXPLICIT member is not inferred from lead ownership.
        const isLeadOwner =
          (await tx.lead.count({
            where: { projectId, ownerId: dto.userId },
          })) > 0;
        return this.toMemberRow(member, user.name, user.email, user.role, isLeadOwner);
      },
    );
  }

  /**
   * DELETE /api/projects/:id/members/:userId - unlink a user from a project.
   * MANAGER/ADMIN/OWNER only. Refuses removal while the user owns or co-owns
   * leads in this project: those leads must be reassigned first so project
   * access cannot be removed from someone still responsible for its leads.
   */
  async unlinkMember(
    actor: JwtPayload,
    projectId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    if (!canManageProjectMembers(actor.role)) {
      throw new ForbiddenException('Only MANAGER, ADMIN or OWNER can unlink members.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const project = await tx.project.findUnique({
          where: { id: projectId },
        });
        if (project === null) {
          throw new NotFoundException(`Project ${projectId} not found.`);
        }
        // Fetch the member's identity for a readable audit reason.
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        const handledLeadCount = await tx.lead.count({
          where: {
            projectId,
            OR: [{ ownerId: userId }, { coOwnerId: userId }],
          },
        });
        if (handledLeadCount > 0) {
          throw new ConflictException(
            `${user?.name ?? 'This member'} is handling ${handledLeadCount} lead${handledLeadCount === 1 ? '' : 's'} in ${project.name}. Reassign those leads to another person before unlinking this member.`,
          );
        }
        const removed = await tx.projectMember.deleteMany({
          where: { projectId, userId },
        });
        if (removed.count === 0) {
          throw new NotFoundException(
            `${user?.name ?? 'This user'} is not explicitly linked to ${project.name}.`,
          );
        }
        // HIGH-STAKES audit (AGENTS.md A2/G-1): removing a staff member's
        // project access is written in the SAME tx as the delete.
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'project.member.unlink',
            organizationId: actor.organizationId,
            entityType: 'Project',
            entityId: projectId,
            before: {
              userId,
              name: user?.name ?? null,
              email: user?.email ?? null,
              projectName: project.name,
            },
            reason: `project.member.unlink by ${actor.email} (${actor.role})`,
          },
        });
        return { ok: true };
      },
    );
  }

  /**
   * GET /api/projects/:id/members - the effective staff list = EXPLICIT
   * ProjectMember rows UNION lead-owners (additive, never regresses). Each
   * row carries `isLeadOwner` provenance so the UI can mark inferred members.
   * Roles are joined from User.role (authoritative single role).
   */
  async listMembers(
    actor: JwtPayload,
    projectId: string,
  ): Promise<ProjectMemberRow[]> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const project = await tx.project.findUnique({
          where: { id: projectId },
        });
        if (project === null) {
          throw new NotFoundException(`Project ${projectId} not found.`);
        }
        const [members, ownerIds] = await Promise.all([
          tx.projectMember.findMany({
            where: { projectId },
            include: { user: { select: { id: true, name: true, email: true, role: true } } },
          }),
          // Distinct lead-owners in this project (the additive half).
          tx.lead.findMany({
            where: { projectId },
            select: { ownerId: true },
            distinct: ['ownerId'],
          }).then((rows) => rows.map((r) => r.ownerId)),
        ]);
        const ownerIdSet = new Set(ownerIds);

        // Build the union, keyed by userId to dedupe explicit∩lead-owner.
        const byUser = new Map<string, ProjectMemberRow>();
        for (const m of members) {
          byUser.set(m.userId, {
            projectId,
            userId: m.userId,
            name: m.user.name,
            email: m.user.email,
            role: m.user.role,
            assignedAt: m.assignedAt.toISOString(),
            isLeadOwner: ownerIdSet.has(m.userId),
          });
        }
        // Lead-owners who aren't explicit members appear too (additive).
        const missingOwnerIds = ownerIds.filter((id) => !byUser.has(id));
        if (missingOwnerIds.length > 0) {
          const owners = await tx.user.findMany({
            where: { id: { in: missingOwnerIds } },
            select: { id: true, name: true, email: true, role: true },
          });
          for (const o of owners) {
            byUser.set(o.id, {
              projectId,
              userId: o.id,
              name: o.name,
              email: o.email,
              role: o.role,
              assignedAt: new Date().toISOString(),
              isLeadOwner: true,
            });
          }
        }
        const rows = [...byUser.values()];
        rows.sort((a, b) => a.name.localeCompare(b.name));
        return rows;
      },
    );
  }

  private toMemberRow(
    m: { assignedAt: Date },
    name: string,
    email: string,
    role: string,
    isLeadOwner: boolean,
  ): ProjectMemberRow {
    return {
      projectId: (m as unknown as { projectId: string }).projectId,
      userId: (m as unknown as { userId: string }).userId,
      name,
      email,
      role,
      assignedAt: m.assignedAt.toISOString(),
      isLeadOwner,
    };
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
    organizationId: string,
  ): Promise<string> {
    let candidate = base;
    let n = 1;
    // Bounded loop: slug has a 64-char column limit in practice; the
    // suffix keeps us well under it for realistic collision counts.
    // T-ORG: slug uniqueness is now per-organization (composite
    // @@unique([organizationId, slug])), so the lookup carries the org.
    while (n < 100) {
      const clash = await tx.project.findUnique({
        where: { organizationId_slug: { organizationId, slug: candidate } },
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