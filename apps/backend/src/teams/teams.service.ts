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
  UpdateTeamDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { isAdminClass } from '../users/roles';

import { TeamAccessService } from './team-access.service';

@Injectable()
export class TeamsService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  // T-TEAM-AUTHORITATIVE (2026-09-13): stateless helper, no DI needed.
  private readonly teamAccess = new TeamAccessService();

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * List the teams the actor can see. T-TEAM-AUTHORITATIVE (2026-09-13,
   * design doc UI1): OWNER/ADMIN see every org team; MANAGER sees every
   * team they MANAGE (Team.managerId) UNION every team they're an
   * ordinary member of (TeamMember, via TeamAccessService); other staff
   * see only their ordinary-member team(s). This is what powers BOTH the
   * Admin -> Teams list and the Work -> My Teams list - same endpoint,
   * role-scoped result.
   */
  async list(actor: JwtPayload): Promise<TeamListItem[]> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const isOverseer = isAdminClass(actor.role);
        let where: { deletedAt: null; id?: { in: string[] } };
        if (isOverseer) {
          where = { deletedAt: null };
        } else {
          // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): TeamMember is
          // the sole membership source now (User.teamId/actor.teamId are
          // gone) - getAccessibleTeamIds (managed teams UNION TeamMember
          // rows) is authoritative, no legacy fallback needed.
          const teamIds = await this.teamAccess.getAccessibleTeamIds(
            tx as never,
            { sub: actor.sub, role: actor.role, organizationId: actor.organizationId },
          );
          where = { deletedAt: null, id: { in: teamIds.length > 0 ? teamIds : ['__none__'] } };
        }
        const rows = await tx.team.findMany({
          where,
          select: {
            id: true,
            name: true,
            defaultAssigneeId: true,
            autoAssignLeads: true,
            managerId: true,
            manager: { select: { name: true } },
            _count: { select: { teamMembers: true } },
          },
          orderBy: { name: 'asc' },
        });
        return rows.map(
          (r): TeamListItem => ({
            id: r.id,
            name: r.name,
            defaultAssigneeId: r.defaultAssigneeId,
            memberCount: r._count.teamMembers,
            managerId: r.managerId,
            managerName: r.manager?.name ?? null,
            autoAssignLeads: r.autoAssignLeads,
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
   * Members = User rows whose teamId matches this team (ordered by name).
   *
   * T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): per-member `projects`
   * (the old ProjectMember-derived list) was REMOVED - ProjectMember was
   * retired (design doc: "per-user project exceptions" are Not in Scope).
   * "Which projects is this member on" is now purely a function of "which
   * projects is this member's TEAM linked to" (ProjectTeam), which is the
   * SAME for every member of the team - see the per-project Staff page
   * (ProjectTeamList) for that view, rather than duplicating it per-row here.
   */
  async getTeam(actor: JwtPayload, id: string): Promise<TeamDetail> {
    // T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI1): ADMIN/OWNER view
    // any team (Admin -> Teams). A MANAGER may also view a team they
    // manage OR are an ordinary member of (Work -> My Teams) - checked
    // below, once the team is loaded, via TeamAccessService so a manager
    // leading multiple teams isn't limited to their JWT-carried teamId.
    if (!isAdminClass(actor.role) && actor.role !== 'MANAGER') {
      throw new ForbiddenException(
        'Only ADMIN, OWNER, or a MANAGER can view a team roster.',
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
        if (actor.role === 'MANAGER') {
          const accessibleTeamIds = await this.teamAccess.getAccessibleTeamIds(
            tx as never,
            { sub: actor.sub, role: actor.role, organizationId: actor.organizationId },
          );
          if (!accessibleTeamIds.includes(id)) {
            throw new ForbiddenException(
              "You can only view a team you manage or belong to.",
            );
          }
        }

        // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): membership is
        // TeamMember rows (Team.managerId, exposed separately as
        // `manager` below, is a distinct leadership axis - a manager
        // doesn't necessarily have their own TeamMember row for a team
        // they lead, matching pre-cutover behavior where the manager
        // likewise wasn't guaranteed to appear via User.teamId).
        const teamMembers = await tx.teamMember.findMany({
          where: { teamId: id, user: { deletedAt: null } },
          select: {
            // T-AUTOASSIGN (2026-09-17): carry each member's routing weight so
            // the roster can show/edit it.
            weight: true,
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        });
        const members = teamMembers
          .map((tm) => ({ ...tm.user, weight: tm.weight }))
          .sort((a, b) => a.name.localeCompare(b.name));

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
          members: members.map((m) => ({
            userId: m.id,
            name: m.name,
            email: m.email,
            role: m.role,
            weight: m.weight,
          })),
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
            // T-AUTOASSIGN (2026-09-17): default false when omitted.
            autoAssignLeads: dto.autoAssignLeads ?? false,
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
            // T-AUTOASSIGN (2026-09-17): explicit `undefined` keeps the
            // current value; only a set flag changes it. (The DTO's optional
            // boolean means a PATCH that omits it doesn't reset the team to
            // false.)
            ...(dto.autoAssignLeads !== undefined ? { autoAssignLeads: dto.autoAssignLeads } : {}),
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
          tx.teamMember.count({ where: { teamId: id, user: { deletedAt: null } } }),
        ]);
        return this.toListItem(updated, manager?.name ?? null, memberCount);
      },
    );
  }

  /**
   * DELETE /api/teams/:id - soft delete (T-TEAM-CRUD). ADMIN/OWNER only.
   * Refuses (409) when the team still has members (TeamMember rows) OR an
   * active manager (Team.managerId != null) - either would otherwise be
   * silently orphaned. The admin must reassign members (bulk or one at a
   * time via `reassignMembers`) and clear/reassign the manager (via
   * `update`) before delete succeeds.
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
        const memberCount = await tx.teamMember.count({
          where: { teamId: id, user: { deletedAt: null } },
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
        // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): moves TeamMember
        // rows, not User.teamId. This legacy endpoint models a single-team
        // "move" for staff whose only membership is this source team - each
        // matching TeamMember row is deleted from the source team and
        // recreated on the target (rather than added alongside, which
        // would silently turn a "move" into an unrequested "add").
        const memberWhere =
          dto.userIds !== undefined
            ? { userId: { in: dto.userIds }, teamId: id }
            : { teamId: id };
        const members = await tx.teamMember.findMany({ where: memberWhere });
        if (members.length === 0) {
          throw new BadRequestException(
            'No matching members found on this team to reassign.',
          );
        }
        const count = members.length;
        await tx.teamMember.deleteMany({ where: memberWhere });
        await tx.teamMember.createMany({
          data: members.map((m) => ({
            userId: m.userId,
            teamId: dto.targetTeamId,
            organizationId: m.organizationId,
            assignedById: actor.sub,
          })),
          skipDuplicates: true,
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
      autoAssignLeads: boolean | null;
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
      autoAssignLeads: team.autoAssignLeads ?? false,
    };
  }
}
