// The narrower directory reads - who may be assigned to a project, who is
// already on its team (Round 67 split).
//
// Both answer a picker, not a table: same shape as CreatedUser so the client
// renders one option component for every list the app offers.

import { ForbiddenException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { LEAD_IN_ACTIVE_PROJECT, PROJECT_ACTIVE } from '../common/soft-delete-filters';
import { OWNER } from './roles';
import { UsersBase } from './users.support';
import type { CreatedUser, UsersDeps } from './users.support';

export class UsersDirectoryScoped extends UsersBase {
  /**
   * GET /api/users/project/:projectId/sales-execs - who can be assigned to a
   * site visit on this project, for the schedule-visit exec picker.
   *
   * T-VISIT-EXEC-SOURCE (2026-09-16). The ORIGINAL implementation derived the
   * list from lead OWNERSHIP (Lead.projectId + Lead.ownerId, filtered to
   * role=SALES_EXEC). That is wrong for this picker: a project can have an
   * assigned exec who simply does not own any lead yet, and then the picker was
   * empty with no way to schedule a visit at all - reported by the owner against
   * shadhil-metro-heights, which had exactly one such exec.
   *
   * Correct semantics: the exec must be STAFFED ON THE PROJECT. `ProjectTeam`
   * is the project↔team link, so:
   *   - execs on any team linked to this project, plus
   *   - the manager of such a team (a manager can conduct a visit too, and the
   *     create() endpoint already accepts SALES_EXEC-or-higher as an assignee).
   *
   * Scoping:
   *   - ADMIN/OWNER: every project member exec/manager.
   *   - MANAGER: only their own team.
   *   - TELECALLER/SALES_EXEC: empty here. A telecaller's picker is fed by
   *     GET /api/users/team (`teamMembers`) instead - the service-side gate is
   *     unchanged, so this is not a permission widening.
   *
   * Lead ownership is kept as a UNION rather than dropped, so an exec who owns a
   * lead in this project is still offered even if their team is not linked (that
   * is how the previous behaviour earned its place).
   */
  async projectSalesExecs(actor: JwtPayload, projectId: string): Promise<CreatedUser[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER' && actor.role !== 'MANAGER') {
      return [];
    }

    // One RLS transaction: `Team` and `Lead` are both FORCE ROW LEVEL
    // SECURITY. On the bare client a MANAGER's team lookup returned [] and
    // the Lead query was filtered by policies evaluating against unset
    // GUCs, so this picker came back empty for the very managers it exists
    // to serve. `User` has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // T-ORG-EXPLICIT: reject a project outside the actor's org up front.
      // `Project`/`ProjectTeam` RLS allow any authenticated role, and RLS bounds
      // cross-org reads only by returning zero rows - which is indistinguishable
      // from "no execs on this project". Fail loudly instead.
      const project = await client.project.findFirst({
        where: {
          id: projectId,
          organizationId: actor.organizationId,
          ...PROJECT_ACTIVE,
        },
        select: { id: true },
      });
      if (project === null) {
        throw new ForbiddenException('Project not found in your organization');
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13): resolve EVERY team the manager
      // leads (JWT teamId is unreliable for managers).
      let managerTeamIds: string[] | null = null;
      if (actor.role === 'MANAGER') {
        const teams = await client.team.findMany({
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
          select: { id: true },
        });
        managerTeamIds = teams.length > 0 ? teams.map((t) => t.id) : ['__none__'];
      }

      // (a) Teams staffed on this project (ProjectTeam = the project↔team link).
      const projectTeams = await client.projectTeam.findMany({
        where: {
          projectId,
          organizationId: actor.organizationId,
          ...(managerTeamIds !== null ? { teamId: { in: managerTeamIds } } : {}),
        },
        select: { teamId: true },
      });
      const projectTeamIds = projectTeams.map((pt) => pt.teamId);

      // The manager of a project team may conduct a visit (create() accepts
      // SALES_EXEC-or-higher), so they belong in the picker too.
      const projectTeamRows =
        projectTeamIds.length > 0
          ? await client.team.findMany({
              where: {
                id: { in: projectTeamIds },
                deletedAt: null,
                organizationId: actor.organizationId,
              },
              select: { id: true, managerId: true },
            })
          : [];
      const teamManagerIds = projectTeamRows
        .map((t) => t.managerId)
        .filter((id): id is string => id !== null);

      // (b) Execs who actually own a lead in this project - kept as a UNION so
      // the previous behaviour is preserved, not replaced.
      const owners = await client.lead.findMany({
        where: {
          projectId,
          ...LEAD_IN_ACTIVE_PROJECT,
          ...(managerTeamIds !== null ? { teamId: { in: managerTeamIds } } : {}),
        },
        select: { ownerId: true },
        distinct: ['ownerId'],
      });
      const ownerIds = owners.map((o) => o.ownerId);

      // Candidates: staffed via a project team (any member) OR a team manager
      // OR a lead owner. Roles are narrowed below.
      const candidateWhere: Record<string, unknown>[] = [];
      if (projectTeamIds.length > 0) {
        candidateWhere.push({ teamMemberships: { some: { teamId: { in: projectTeamIds } } } });
      }
      if (teamManagerIds.length > 0) {
        candidateWhere.push({ id: { in: teamManagerIds } });
      }
      if (ownerIds.length > 0) {
        candidateWhere.push({ id: { in: ownerIds } });
      }
      if (candidateWhere.length === 0) return [];

      const execs = await client.user.findMany({
        where: {
          OR: candidateWhere,
          // SALES_EXEC or MANAGER: the roles the visit-create endpoint accepts
          // as an assignee (a TELECALLER assignee is rejected server-side, so
          // offering one here would produce a guaranteed 400).
          role: { in: ['SALES_EXEC', 'MANAGER'] },
          deletedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): newest
          // TeamMember row (SALES_EXEC is never a manager, so no
          // Team.managerId branch needed - see resolveDisplayTeamId).
          // 2026-11-07 (D8): was 'asc' - see resolveDisplayTeamId.
          teamMemberships: {
            select: { teamId: true },
            orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      });

      // A MANAGER's own team rows resolve teamId from the team they lead, since
      // a manager has no TeamMember row for it.
      const managerTeamByUser = new Map(
        projectTeamRows
          .filter((t) => t.managerId !== null)
          .map((t) => [t.managerId as string, t.id]),
      );

      return execs.map((e) => ({
        id: e.id,
        email: e.email,
        name: e.name,
        role: e.role,
        teamId: e.teamMemberships[0]?.teamId ?? managerTeamByUser.get(e.id) ?? null,
      }));
    });
  }

  /**
   * GET /api/users/team - the actor's team + manager, for the chat
   * mention picker. Unlike `list` (staff→self only), this returns the
   * whole team so a telecaller can see + mention their manager and
   * teammates. Scoping:
   *   - OWNER/ADMIN: all users (they can mention anyone).
   *   - MANAGER: their own team (resolved via Team.managerId).
   *   - TELECALLER/SALES_EXEC: their team + the team's manager.
   * Returns the same CreatedUser shape as `list`.
   */
  async teamMembers(actor: JwtPayload, projectId?: string): Promise<CreatedUser[]> {
    // One RLS transaction: Team/TeamMember are FORCE ROW LEVEL SECURITY, so
    // the bare client resolved `[]` for the actor's teams and this mention
    // picker returned an empty roster. `User` has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      let where: Record<string, unknown>;
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        if (projectId === undefined) {
          // T-ORG-EXPLICIT: was `{}` - the entire directory, with no org scoping
          // and no soft-delete filter, for an admin/owner's @mention picker.
          where = {
            deletedAt: null,
            organizationId: actor.organizationId,
          };
        } else {
          // T-USER-PROJECT-SCOPE: an ADMIN/OWNER has no natural team, so their
          // mention picker listed the WHOLE directory. When the chat pane passes
          // the active project, offer that project's staff instead: members of a
          // project-staffed team, plus those teams' managers.
          // T-ORG-EXPLICIT: same cross-org guard as `list` - reject another
          // org's project instead of returning a misleadingly empty roster.
          const project = await client.project.findFirst({
            where: {
              id: projectId,
              organizationId: actor.organizationId,
              ...PROJECT_ACTIVE,
            },
            select: { id: true },
          });
          if (project === null) {
            throw new ForbiddenException('Project not found in your organization');
          }
          const staffed = await client.projectTeam.findMany({
            where: { projectId, organizationId: actor.organizationId },
            select: { teamId: true },
          });
          const staffedTeamIdsForFilter = staffed.map((pt) => pt.teamId);
          const staffedTeamsForFilter =
            staffedTeamIdsForFilter.length > 0
              ? await client.team.findMany({
                  where: {
                    id: { in: staffedTeamIdsForFilter },
                    deletedAt: null,
                    organizationId: actor.organizationId,
                  },
                  select: { managerId: true },
                })
              : [];
          const mgrIds = staffedTeamsForFilter
            .map((t) => t.managerId)
            .filter((id): id is string => id !== null);

          const scope: Record<string, unknown>[] = [];
          if (staffedTeamIdsForFilter.length > 0) {
            scope.push({
              teamMemberships: { some: { teamId: { in: staffedTeamIdsForFilter } } },
            });
          }
          if (mgrIds.length > 0) scope.push({ id: { in: mgrIds } });
          // Never hide the caller from their own picker.
          scope.push({ id: actor.sub });

          where = { organizationId: actor.organizationId, OR: scope };
        }
      } else {
        // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolve EVERY
        // team the actor is associated with. Managers link via
        // Team.managerId (a manager may lead multiple teams); ordinary
        // staff link via their own TeamMember rows (User.teamId/the JWT
        // teamId claim are gone - a staff member can now be on multiple
        // teams too, so this resolves ALL of them, not just one).
        let teamIds: string[];
        if (actor.role === 'MANAGER') {
          const teams = await client.team.findMany({
            // T-ORG-EXPLICIT: see `list` - never rely on a join to imply the org.
            where: {
              managerId: actor.sub,
              deletedAt: null,
              organizationId: actor.organizationId,
            },
          });
          teamIds = teams.map((t) => t.id);
        } else {
          const memberships = await client.teamMember.findMany({
            // T-ORG-EXPLICIT: read the denormalized org column directly instead
            // of relying on the org-scoped Team join downstream.
            where: { userId: actor.sub, organizationId: actor.organizationId },
            select: { teamId: true },
          });
          teamIds = memberships.map((m) => m.teamId);
        }
        if (teamIds.length === 0) {
          // No team - the actor can only mention themselves.
          return [];
        }
        // Team members + each team's manager (so staff can loop their
        // manager even though the manager isn't a TeamMember row).
        const teams = await client.team.findMany({
          where: { id: { in: teamIds }, organizationId: actor.organizationId },
          select: { managerId: true },
        });
        const managerIds = Array.from(
          new Set(teams.map((t) => t.managerId).filter((id): id is string => id !== null)),
        );
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          OR: [
            { teamMemberships: { some: { teamId: { in: teamIds } } } },
            { id: { in: managerIds.length > 0 ? managerIds : ['__none__'] } },
          ],
        };
      }

      const users = await client.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          teamMemberships: {
            select: { teamId: true },
            // 2026-11-07 (D8): was 'asc' - newest membership is the display
            // team, matching resolveDisplayTeamId.
            orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
        take: 200,
      });
      // Managers resolve their display teamId via Team.managerId (see
      // resolveDisplayTeamId); everyone else uses their newest TeamMember row.
      const managerRows = users.filter((u) => u.role === 'MANAGER');
      const ledTeams =
        managerRows.length > 0
          ? await client.team.findMany({
              where: { managerId: { in: managerRows.map((u) => u.id) }, deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, managerId: true },
            })
          : [];
      const ledTeamByManagerId = new Map<string, string>();
      for (const t of ledTeams) {
        if (t.managerId !== null && !ledTeamByManagerId.has(t.managerId)) {
          ledTeamByManagerId.set(t.managerId, t.id);
        }
      }
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        teamId:
          (u.role === 'MANAGER' ? ledTeamByManagerId.get(u.id) : u.teamMemberships[0]?.teamId) ??
          null,
      }));
    });
  }
}
