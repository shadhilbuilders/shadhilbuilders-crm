// Teams service - data access for the teams endpoints.
//
// The list() method respects the global RLS context: withRlsContext
// sets the app.user_id session var, and the Team table's RLS policy
// (see packages/database/prisma/rls/policies.sql) filters rows to
// teams the user is a member of. All reads run inside withRlsContext
// (per shadhil-crm-dev rule: every business query runs inside
// withRlsContext; the bare client is for migrations/seed/auth).
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { PrismaClient } from '@shadhil/database';
import type { TeamDetail, TeamListItem, TeamMemberProject } from '@shadhil/api-types';

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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // OWNER/ADMIN oversee every team (mirrors the leads scoping
        // convention - role lane, not membership). MANAGER/TELECALLER/
        // SALES_EXEC see only teams they are members of.
        const isOverseer = isAdminClass(actor.role);
        const rows = await tx.team.findMany({
          where: isOverseer
            ? {}
            : {
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const team = await tx.team.findUnique({
          where: { id },
          include: {
            manager: { select: { id: true, name: true, email: true } },
          },
        });
        if (team === null) {
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
}
