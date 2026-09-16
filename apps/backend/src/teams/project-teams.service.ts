// ProjectTeamsService - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit
// Trail #39). Backs the project Staff page's grouped-team view: projects
// link to TEAMS (via the additive `ProjectTeam` join), never directly to
// users. Staff members are team-derived only - this is deliberately
// separate from the legacy `ProjectMember`/lead-owner-union surface
// (`ProjectsService.listMembers`), which stays untouched until the
// service/RLS cutover phase.
//
// Endpoints (design doc "API contracts"):
//   GET    /api/projects/:projectId/teams
//   POST   /api/projects/:projectId/teams
//   DELETE /api/projects/:projectId/teams/:teamId
//
// Authorization matrix (design doc): Link/unlink ProjectTeam is Owner/
// Admin-only on any organization project - NOT a Manager capability (unlike
// ProjectMember's canManageProjectMembers, which also allows MANAGER).
import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withRlsContext, rlsContextFrom, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  LinkProjectTeamDto,
  ProjectTeamRow,
  ProjectTeamsResponse,
  TeamMembership,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { isAdminClass } from '../users/roles';
import {
  CodedBadRequestException,
  CodedConflictException,
  CodedForbiddenException,
  CodedNotFoundException,
} from '../common/errors/coded-exception';

type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
>;

@Injectable()
export class ProjectTeamsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/projects/:projectId/teams - every team linked via ProjectTeam,
   * each with manager identity, member count, lead count (this project +
   * this team only), the full read-only roster, and `canUnlink` (Owner/
   * Admin AND zero leads - the UI never has to re-derive the rule).
   */
  async list(actor: JwtPayload, projectId: string): Promise<ProjectTeamsResponse> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (project === null || project.deletedAt !== null) {
        throw new NotFoundException(`Project ${projectId} not found.`);
      }

      const links = await tx.projectTeam.findMany({
        where: { projectId },
        include: {
          team: {
            include: { manager: { select: { id: true, name: true } } },
          },
        },
        orderBy: { assignedAt: 'asc' },
      });

      const rows: ProjectTeamRow[] = await Promise.all(
        links.map(async (link) => {
          const [members, leadCount] = await Promise.all([
            this.buildMembership(tx, link.teamId),
            tx.lead.count({ where: { projectId, teamId: link.teamId } }),
          ]);
          return {
            teamId: link.teamId,
            teamName: link.team.name,
            manager: link.team.manager
              ? { id: link.team.manager.id, name: link.team.manager.name }
              : null,
            memberCount: members.length,
            leadCount,
            members,
            canUnlink: isAdminClass(actor.role) && leadCount === 0,
          };
        }),
      );

      return { projectId, teams: rows };
    });
  }

  /**
   * POST /api/projects/:projectId/teams - link a team. ADMIN/OWNER only.
   * The team must be active, in the same org, and have a manager assigned
   * (design doc: "Legacy managerless teams are excluded ... Assign a
   * manager before linking this team" - enforced here too, not just in the
   * picker, so the write path can't be bypassed). Idempotent: linking an
   * already-linked team returns its current row rather than erroring.
   */
  async link(
    actor: JwtPayload,
    projectId: string,
    dto: LinkProjectTeamDto,
  ): Promise<ProjectTeamRow> {
    if (!isAdminClass(actor.role)) {
      throw new CodedForbiddenException(
        'PROJECT_TEAM_LINK_FORBIDDEN',
        'Only ADMIN or OWNER can link a team to a project.',
      );
    }
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (project === null || project.deletedAt !== null) {
        throw new NotFoundException(`Project ${projectId} not found.`);
      }
      const team = await tx.team.findUnique({ where: { id: dto.teamId } });
      if (team === null || team.deletedAt !== null) {
        throw new NotFoundException(`Team ${dto.teamId} not found.`);
      }
      if (team.organizationId !== project.organizationId) {
        throw new CodedBadRequestException(
          'PROJECT_TEAM_CROSS_ORG',
          'The team and project must belong to the same organization.',
        );
      }
      if (team.managerId === null) {
        throw new CodedBadRequestException(
          'TEAM_MANAGERLESS',
          `Team "${team.name}" has no manager assigned yet. Assign a manager before linking this team.`,
        );
      }

      await tx.projectTeam.upsert({
        where: { projectId_teamId: { projectId, teamId: dto.teamId } },
        update: {},
        create: {
          projectId,
          teamId: dto.teamId,
          organizationId: actor.organizationId,
          assignedById: actor.sub,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'project.team.link',
          organizationId: actor.organizationId,
          entityType: 'Project',
          entityId: projectId,
          after: { teamId: dto.teamId, teamName: team.name },
          reason: `project.team.link by ${actor.email} (${actor.role})`,
        },
      });

      const [members, leadCount, manager] = await Promise.all([
        this.buildMembership(tx, dto.teamId),
        tx.lead.count({ where: { projectId, teamId: dto.teamId } }),
        team.managerId !== null
          ? tx.user.findUnique({
              where: { id: team.managerId },
              select: { id: true, name: true },
            })
          : Promise.resolve(null),
      ]);
      return {
        teamId: dto.teamId,
        teamName: team.name,
        manager: manager ? { id: manager.id, name: manager.name } : null,
        memberCount: members.length,
        leadCount,
        members,
        canUnlink: isAdminClass(actor.role) && leadCount === 0,
      };
    });
  }

  /**
   * DELETE /api/projects/:projectId/teams/:teamId - unlink a team.
   * ADMIN/OWNER only. Blocked (409 PROJECT_TEAM_HAS_LEADS) while any Lead
   * carries this exact (projectId, teamId) pair - the operator must
   * reassign those leads through existing lead controls first (bulk
   * team-to-team transfer is explicitly out of scope, per the design doc).
   */
  async unlink(
    actor: JwtPayload,
    projectId: string,
    teamId: string,
  ): Promise<{ ok: true }> {
    if (!isAdminClass(actor.role)) {
      throw new CodedForbiddenException(
        'PROJECT_TEAM_UNLINK_FORBIDDEN',
        'Only ADMIN or OWNER can unlink a team from a project.',
      );
    }
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const [project, team, link] = await Promise.all([
        tx.project.findUnique({ where: { id: projectId } }),
        tx.team.findUnique({ where: { id: teamId } }),
        tx.projectTeam.findUnique({
          where: { projectId_teamId: { projectId, teamId } },
        }),
      ]);
      if (project === null || project.deletedAt !== null) {
        throw new NotFoundException(`Project ${projectId} not found.`);
      }
      if (link === null) {
        throw new CodedNotFoundException(
          'PROJECT_TEAM_NOT_LINKED',
          `Team ${teamId} is not linked to project ${projectId}.`,
        );
      }

      const leadCount = await tx.lead.count({ where: { projectId, teamId } });
      if (leadCount > 0) {
        throw new CodedConflictException(
          'PROJECT_TEAM_HAS_LEADS',
          `${leadCount} lead${leadCount === 1 ? '' : 's'} are assigned to this team on this project. Reassign them before unlinking.`,
          { leadCount },
        );
      }

      await tx.projectTeam.delete({
        where: { projectId_teamId: { projectId, teamId } },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'project.team.unlink',
          organizationId: actor.organizationId,
          entityType: 'Project',
          entityId: projectId,
          before: { teamId, teamName: team?.name ?? null },
          reason: `project.team.unlink by ${actor.email} (${actor.role})`,
        },
      });
      return { ok: true };
    });
  }

  /**
   * Every membership row for a team: ordinary `TeamMember` rows plus the
   * team's manager, WITHOUT double-counting when the manager also holds a
   * separate ordinary `TeamMember` row for this same team (schema.prisma's
   * `TeamMember` comment: that only happens when the manager is ALSO an
   * ordinary member of a DIFFERENT team - never this one - but this guard
   * costs nothing and matches the design doc's `isManagerSlot` contract
   * exactly either way).
   */
  private async buildMembership(tx: Tx, teamId: string): Promise<TeamMembership[]> {
    const [team, memberRows] = await Promise.all([
      tx.team.findUnique({
        where: { id: teamId },
        select: { manager: { select: { id: true, name: true, email: true, role: true } } },
      }),
      tx.teamMember.findMany({
        where: { teamId },
        include: { user: { select: { name: true, email: true, role: true } } },
        orderBy: { assignedAt: 'asc' },
      }),
    ]);

    const manager = team?.manager ?? null;
    const rows: TeamMembership[] = memberRows.map((m) => ({
      userId: m.userId,
      teamId,
      name: m.user.name,
      email: m.user.email,
      role: m.user.role,
      assignedAt: m.assignedAt.toISOString(),
      // Edge case guard (shouldn't happen per the TeamMember model
      // comment, but costs nothing to handle): if the manager somehow
      // ALSO holds an ordinary row for this same team, still pin them.
      isManagerSlot: manager !== null && manager.id === m.userId,
    }));

    if (manager !== null && !rows.some((r) => r.userId === manager.id)) {
      rows.unshift({
        userId: manager.id,
        teamId,
        name: manager.name,
        email: manager.email,
        role: manager.role,
        assignedAt: new Date(0).toISOString(),
        isManagerSlot: true,
      });
    }
    return rows;
  }
}
