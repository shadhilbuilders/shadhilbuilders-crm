// Teams service - data access for the teams endpoints.
//
// The list() method respects the global RLS context: withRlsContext
// sets the app.user_id session var, and the Team table's RLS policy
// (see packages/database/prisma/rls/policies.sql) filters rows to
// teams the user is a member of. All reads run inside withRlsContext
// (per shadhil-crm-dev rule: every business query runs inside
// withRlsContext; the bare client is for migrations/seed/auth).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withRlsContext, rlsContextFrom } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { PrismaClient } from '@shadhil/database';
import type {
  CreateTeamDto,
  ReassignTeamMembersDto,
  TeamDetail,
  TeamListItem,
  TeamMemberProject,
  UpdateTeamDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { isAdminClass } from '../users/roles';

@Injectable()
export class TeamsService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /** List the teams the actor is a member of. RLS-filtered. */
  async list(actor: JwtPayload): Promise<TeamListItem[]> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // OWNER/ADMIN oversee every team (mirrors the leads scoping
        // convention - role lane, not membership). MANAGER/TELECALLER/
        // SALES_EXEC see only teams they are members of.
        const isOverseer = isAdminClass(actor.role);
        // T-TEAM-CRUD: soft-deleted teams never appear in the list.
        const rows = await tx.team.findMany({
          where: isOverseer
            ? { deletedAt: null }
            : {
                deletedAt: null,
                // Belt-and-braces: even though the RLS policy on Team
                // already filters to rows where the user appears in
                // members, we add an explicit where so the SQL is
                // self-documenting and the index is obvious. With FORCE
                // RLS the policy is the only thing that matters, so this
                // is redundant - but if RLS is ever dropped in a future
                // migration, this still gives the right answer.
                members: { some: { id: actor.sub } },
              },
          select: {
            id: true,
            name: true,
            defaultAssigneeId: true,
            managerId: true,
            manager: { select: { name: true } },
            _count: { select: { members: true } },
          },
          orderBy: { name: 'asc' },
        });
        return rows.map(
          (r): TeamListItem => ({
            id: r.id,
            name: r.name,
            defaultAssigneeId: r.defaultAssigneeId,
            memberCount: r._count.members,
            managerId: r.managerId,
            managerName: r.manager?.name ?? null,
          }),
        );
      },
    );
  }

  /**
   * GET /api/teams/:id - the full roster for the ADMIN/OWNER org-Teams page.
   * ADMIN/OWNER only (a MANAGER should use the per-project staff surfaces,
   * not see every team).
   *
   * Members = User rows whose teamId matches this team (ordered by name),
   * each with the projects they are an EXPLICIT ProjectMember of (unlinkable
   * via DELETE /api/projects/:id/members/:userId). `isLeadOwnerOnly` marks a
   * member who is a lead-owner on a project WITHOUT an explicit ProjectMember
   * row — the UI shows those as read-only "via leads" rows (Unlink disabled).
   */
  async getTeam(actor: JwtPayload, id: string): Promise<TeamDetail> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can view the org teams.',
      );
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const team = await tx.team.findUnique({
          where: { id },
          include: {
            manager: { select: { id: true, name: true, email: true } },
          },
        });
        // T-TEAM-CRUD: a soft-deleted team 404s like a missing one.
        if (team === null || team.deletedAt !== null) {
          throw new NotFoundException(`Team ${id} not found.`);
        }

        const members = await tx.user.findMany({
          where: { teamId: id, deletedAt: null },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            // EXPLICIT ProjectMember rows for this user (unlinkable).
            projectMembers: {
              select: {
                project: { select: { id: true, name: true } },
                role: true,
              },
            },
            // Distinct projects this user is a lead-owner/co-owner of (the
            // additive/provenance half - these are NOT unlinkable).
            ownedLeads: {
              where: { projectId: { not: null } },
              select: { project: { select: { id: true, name: true } } },
            },
            coOwnedLeads: {
              where: { projectId: { not: null } },
              select: { project: { select: { id: true, name: true } } },
            },
          },
        });

        return {
          id: team.id,
          name: team.name,
          manager: team.manager
            ? {
                id: team.manager.id,
                name: team.manager.name,
                email: team.manager.email,
              }
            : null,
          members: members.map((m) => {
            // EXPLICIT ProjectMember rows (unlinkable).
            const byProject = new Map<string, TeamMemberProject>();
            for (const pm of m.projectMembers) {
              if (byProject.has(pm.project.id)) continue;
              byProject.set(pm.project.id, {
                projectId: pm.project.id,
                projectName: pm.project.name,
                role: m.role,
                isLeadOwner: false,
              });
            }
            // UNION with lead-owner/co-owner projects (read-only unless the
            // member is ALSO an explicit ProjectMember, whose row wins).
            for (const lead of [...m.ownedLeads, ...m.coOwnedLeads]) {
              const proj = lead.project;
              if (!proj || byProject.has(proj.id)) continue;
              byProject.set(proj.id, {
                projectId: proj.id,
                projectName: proj.name,
                role: m.role,
                isLeadOwner: true,
              });
            }
            return {
              userId: m.id,
              name: m.name,
              email: m.email,
              role: m.role,
              projects: Array.from(byProject.values()).sort((a, b) =>
                a.projectName.localeCompare(b.projectName),
              ),
            };
          }),
        };
      },
    );
  }

  /**
   * POST /api/teams - create a team. ADMIN/OWNER only. `managerId` (if
   * given) must be an existing `MANAGER` who isn't already leading a
   * different active team - "managers always lead exactly one team" is an
   * invariant enforced elsewhere (users.service.ts create/update), so this
   * is the write path that must uphold it too.
   */
  async create(actor: JwtPayload, dto: CreateTeamDto): Promise<TeamListItem> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can create teams.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const managerId = await this.assertManagerAssignable(
          tx as unknown as PrismaClient,
          dto.managerId ?? null,
          null,
        );
        const created = await tx.team.create({
          data: {
            name: dto.name,
            managerId,
            organizationId: actor.organizationId,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'team.create',
            organizationId: actor.organizationId,
            entityType: 'Team',
            entityId: created.id,
            after: { name: created.name, managerId: created.managerId },
            reason: `team.create by ${actor.email} (${actor.role})`,
          },
        });
        return this.toListItem(created, null);
      },
    );
  }

  /**
   * PATCH /api/teams/:id - rename and/or reassign the manager. ADMIN/OWNER
   * only. Same manager-assignability guard as `create`, excluding this
   * team itself so re-saving the current manager is a no-op, not a 409.
   */
  async update(
    actor: JwtPayload,
    id: string,
    dto: UpdateTeamDto,
  ): Promise<TeamListItem> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can edit teams.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.team.findUnique({ where: { id } });
        if (existing === null || existing.deletedAt !== null) {
          throw new NotFoundException(`Team ${id} not found.`);
        }
        const managerId =
          dto.managerId !== undefined
            ? await this.assertManagerAssignable(
                tx as unknown as PrismaClient,
                dto.managerId,
                id,
              )
            : existing.managerId;
        const updated = await tx.team.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.managerId !== undefined ? { managerId } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'team.update',
            organizationId: actor.organizationId,
            entityType: 'Team',
            entityId: id,
            before: { name: existing.name, managerId: existing.managerId },
            after: { name: updated.name, managerId: updated.managerId },
            reason: `team.update by ${actor.email} (${actor.role})`,
          },
        });
        const [manager, memberCount] = await Promise.all([
          updated.managerId !== null
            ? tx.user.findUnique({
                where: { id: updated.managerId },
                select: { name: true },
              })
            : Promise.resolve(null),
          tx.user.count({ where: { teamId: id, deletedAt: null } }),
        ]);
        return this.toListItem(updated, manager?.name ?? null, memberCount);
      },
    );
  }

  /**
   * DELETE /api/teams/:id - soft delete (T-TEAM-CRUD). ADMIN/OWNER only.
   * Refuses (409) when the team still has members (User.teamId = id) OR
   * an active manager (Team.managerId != null) - either would otherwise be
   * silently orphaned (members via User.teamId onDelete:SetNull; the
   * manager because every "resolve my team" lookup in users.service.ts
   * goes through `team.findFirst({ managerId })`, not the manager's own
   * teamId). The admin must reassign members (bulk or one at a time via
   * `reassignMembers`) and clear/reassign the manager (via `update`)
   * before delete succeeds.
   */
  async remove(actor: JwtPayload, id: string): Promise<{ id: string }> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can delete teams.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await tx.team.findUnique({ where: { id } });
        if (existing === null || existing.deletedAt !== null) {
          throw new NotFoundException(`Team ${id} not found.`);
        }
        const memberCount = await tx.user.count({
          where: { teamId: id, deletedAt: null },
        });
        if (memberCount > 0) {
          throw new ConflictException(
            `Team "${existing.name}" still has ${memberCount} member(s). ` +
              'Reassign them to another team before deleting.',
          );
        }
        if (existing.managerId !== null) {
          const manager = await tx.user.findUnique({
            where: { id: existing.managerId },
            select: { name: true },
          });
          throw new ConflictException(
            `Team "${existing.name}" is still led by ${manager?.name ?? 'a manager'}. ` +
              'Reassign or clear the manager before deleting.',
          );
        }
        await tx.team.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'team.delete',
            organizationId: actor.organizationId,
            entityType: 'Team',
            entityId: id,
            before: { name: existing.name },
            reason: `team.delete (soft) by ${actor.email} (${actor.role})`,
          },
        });
        return { id };
      },
    );
  }

  /**
   * POST /api/teams/:id/reassign-members - move members off this team.
   * ADMIN/OWNER only. Omitting `dto.userIds` moves EVERY current member
   * (the one-click bulk action that unblocks delete); a non-empty array
   * moves only those members (the per-member "move to another team"
   * action on the roster page). Does NOT touch `managerId` - the manager
   * link is a separate concept, cleared/reassigned via `update`.
   */
  async reassignMembers(
    actor: JwtPayload,
    id: string,
    dto: ReassignTeamMembersDto,
  ): Promise<{ count: number }> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can reassign team members.');
    }
    if (dto.targetTeamId === id) {
      throw new BadRequestException('The target team must be different from the source team.');
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const [sourceTeam, targetTeam] = await Promise.all([
          tx.team.findUnique({ where: { id } }),
          tx.team.findUnique({ where: { id: dto.targetTeamId } }),
        ]);
        if (sourceTeam === null || sourceTeam.deletedAt !== null) {
          throw new NotFoundException(`Team ${id} not found.`);
        }
        if (targetTeam === null || targetTeam.deletedAt !== null) {
          throw new NotFoundException(`Team ${dto.targetTeamId} not found.`);
        }
        const memberWhere =
          dto.userIds !== undefined
            ? { id: { in: dto.userIds }, teamId: id }
            : { teamId: id };
        const count = await tx.user.count({ where: memberWhere });
        if (count === 0) {
          throw new BadRequestException(
            'No matching members found on this team to reassign.',
          );
        }
        await tx.user.updateMany({
          where: memberWhere,
          data: { teamId: dto.targetTeamId },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'team.reassign_members',
            organizationId: actor.organizationId,
            entityType: 'Team',
            entityId: id,
            before: { sourceTeamId: id, memberCount: count },
            after: { targetTeamId: dto.targetTeamId },
            reason: `team.reassign_members by ${actor.email} (${actor.role})`,
          },
        });
        return { count };
      },
    );
  }

  /**
   * Validate a `managerId` candidate for create/update: null clears the
   * manager (always allowed); otherwise the user must exist and be a
   * `MANAGER`.
   *
   * T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail #39): REMOVES
   * the "manager already leads a DIFFERENT team" guard that used to live
   * here. One manager may now lead multiple teams - that's the whole
   * point of the cutover (design doc fixture #1: "Manager Meera leads
   * Metro Sales and Launch Support"). `excludeTeamId` is now unused by
   * this method but kept as a parameter (harmless) so every call site
   * doesn't need to change.
   */
  private async assertManagerAssignable(
    tx: Omit<
      PrismaClient,
      '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
    >,
    managerId: string | null,
    _excludeTeamId: string | null,
  ): Promise<string | null> {
    if (managerId === null) return null;
    const user = await tx.user.findUnique({
      where: { id: managerId },
      select: { id: true, role: true },
    });
    if (user === null) {
      throw new NotFoundException(`User ${managerId} not found.`);
    }
    if (user.role !== 'MANAGER') {
      throw new BadRequestException(
        `User ${managerId} is not a MANAGER and cannot lead a team.`,
      );
    }
    return managerId;
  }

  private toListItem(
    team: {
      id: string;
      name: string;
      defaultAssigneeId: string | null;
      managerId: string | null;
    },
    managerName: string | null,
    memberCount = 0,
  ): TeamListItem {
    return {
      id: team.id,
      name: team.name,
      defaultAssigneeId: team.defaultAssigneeId,
      memberCount,
      managerId: team.managerId,
      managerName,
    };
  }
}
