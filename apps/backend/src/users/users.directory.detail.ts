// One user, as the detail screen needs them (Round 67 split).
//
// Reads only: the row, its team, its reporting line, its photo URL. Nothing
// here writes, which is why it takes the actor and returns a DTO.

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { reportingTargetFor, reportsToTeamManager } from '@shadhil/api-types';
import type { UserDetail } from '@shadhil/api-types';
import { PROJECT_ACTIVE } from '../common/soft-delete-filters';
import { OWNER, findOrgOwner } from './roles';
import { UsersBase } from './users.support';
import type { UsersDeps } from './users.support';

export class UsersDirectoryDetail extends UsersBase {
  /**
   * GET /api/users/:id - the user detail page (users/[userId], autoplan
   * 2026-09-13). Scope mirrors `list()`: OWNER/ADMIN see anyone; MANAGER
   * sees their own team's members (+ themselves); staff see only
   * themselves. `manager` ("Reports to") is populated per role:
   *   - TELECALLER/SALES_EXEC: their resolved team's manager (assignable,
   *     see `assignManager` below).
   *   - MANAGER/ADMIN: the org OWNER (T-REPORTS-TO-OWNER - fixed, never
   *     assignable; see `findOrgOwner`).
   *   - OWNER: null (reports to nobody).
   */
  async getUser(actor: JwtPayload, targetUserId: string): Promise<UserDetail> {
    // The Team/TeamMember reads below are FORCE ROW LEVEL SECURITY, so the
    // whole lookup runs in one RLS transaction with the actor's GUCs -
    // otherwise `resolveDisplayTeamId` returns null and the response
    // silently reports teamId/teamName/manager/projects as empty.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // T-ORG-EXPLICIT (2026-11-25): the read used to be `findUnique({ id,
      // deletedAt: null })`. `User` has no RLS, so an ADMIN in org A could read
      // another org's user detail (email, phone, role, reporting line) by id.
      // The org term rides on the same unique lookup rather than a `findFirst`:
      // this method's mock harness already models two DISTINCT `user.findFirst`
      // consumers (this read and `findOrgOwner`), and Prisma compiles the extra
      // filter into the same `WHERE id = ... AND organizationId = ...`.
      const target = await client.user.findUnique({
        where: {
          id: targetUserId,
          organizationId: actor.organizationId,
          deletedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          // 2026-11-18: staff phone + the customer's lead pointer. A CUSTOMER
          // has no phone of their own; theirs is derived from the lead below.
          phone: true,
          // 2026-11-24: the photo key. Resolved to a URL below, because the
          // provider's public base is a server concern and the web must never
          // build a media path of its own.
          avatarKey: true,
          customerLeadId: true,
        },
      });
      if (target === null) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId/the
      // legacy singular `team` relation are gone - resolve the target's
      // display team via the same rule as create()/changeRole()
      // (resolveDisplayTeamId), then fetch that team's manager + linked
      // projects (ProjectTeam) separately.
      const teamId = await this.resolveDisplayTeamId(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );
      const team =
        teamId !== null
          ? await client.team.findUnique({
              where: { id: teamId },
              select: {
                id: true,
                name: true,
                manager: { select: { id: true, name: true, email: true } },
                // "Which projects" is "which projects is this user's TEAM
                // linked to" (ProjectTeam) - ProjectMember (per-user
                // linking) was retired. Read-only here (linking happens on
                // the project's Staff page, at the team level).
                // T-SOFT-DELETE: a link to a soft-deleted project must not
                // surface as one of this user's projects.
                projectTeams: {
                  where: { project: { deletedAt: null } },
                  select: { project: { select: { id: true, name: true } } },
                  orderBy: { project: { name: 'asc' } },
                },
              },
            })
          : null;

      // Scope check - mirrors list()'s role lanes.
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        // sees anyone.
      } else if (actor.role === 'MANAGER') {
        // T-TEAM-AUTHORITATIVE (2026-09-13): a manager may lead multiple
        // teams - check membership in the FULL managed-team set.
        const teams = await client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null },
          select: { id: true },
        });
        const inOwnTeam = teamId !== null && teams.some((t) => t.id === teamId);
        if (!inOwnTeam && target.id !== actor.sub) {
          throw new ForbiddenException("You can only view your own team's users");
        }
      } else if (target.id !== actor.sub) {
        throw new ForbiddenException('You can only view your own user');
      }

      // T-REPORTS-TO-OWNER: "manager" is this user's reporting-line
      // superior, and WHO that is depends on the target's own role, not a
      // single rule. TELECALLER/SALES_EXEC/ENGINEER report to their team's
      // manager (assignable); MANAGER/ADMIN report to the org OWNER (fixed);
      // OWNER/CUSTOMER report to nobody.
      //
      // 2026-11-07: the role check is a shared, EXHAUSTIVE map
      // (@shadhil/api-types reportingTargetFor) rather than an inline union.
      // ENGINEER was missing here for three weeks because the union was not
      // exhaustive and TypeScript had no way to object.
      const reportsToManager = reportsToTeamManager(target.role as Role);
      const reportsToOwner = reportingTargetFor(target.role as Role) === 'ORG_OWNER';

      // The full list of lines (2026-11-07): every team this user is on, with
      // that team's manager, newest first.
      const reportsTo = await this.resolveReportingLines(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );

      // `manager` is the single-value view the existing card and the assign
      // button read, DERIVED from the list rather than fetched separately.
      //
      // Deriving matters beyond tidiness: before this, MANAGER/ADMIN rows hit
      // findOrgOwner twice per getUser (once here, once in the resolver), which
      // is a wasted round trip on every user detail view and made the two
      // values free to disagree if the org's OWNER changed between the calls.
      //
      // Null for OWNER/CUSTOMER: resolveReportingLines returns [] for NONE, and
      // for a team with no manager the first line's manager is null - both of
      // which are the answers this field already gave.
      const primaryManager = reportsTo[0]?.manager ?? null;

      // Every team this user belongs to, newest first - the "assign manager"
      // picker excludes them all. `teamId` above is only the DISPLAY team, so
      // a two-team engineer could otherwise "assign" to a team they are
      // already on and get a success toast for a no-op (2026-11-07).
      const allMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
        // Same tie-break as resolveDisplayTeamId (see the note there).
        orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
      });

      // 2026-11-18: a CUSTOMER's number lives on their lead, never on the
      // account. Read under the actor's RLS context, which is safe for the
      // roles that can reach a customer row here: ADMIN/OWNER hold
      // lead_select_admin. A MANAGER is already 403'd above (a customer has no
      // team), and a buyer reading THEMSELF never lands here - `Lead` has no
      // CUSTOMER SELECT policy, so that read would return zero rows silently
      // rather than erroring. A missing/soft-deleted lead reads as null.
      const derivedCustomerPhone =
        target.role === 'CUSTOMER' && target.customerLeadId !== null
          ? ((
              await client.lead.findFirst({
                where: {
                  id: target.customerLeadId,
                  organizationId: actor.organizationId,
                },
                select: { phone: true },
              })
            )?.phone ?? null)
          : null;

      return {
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        phone: target.role === 'CUSTOMER' ? derivedCustomerPhone : (target.phone ?? null),
        phoneSource: target.role === 'CUSTOMER' ? 'LEAD' : 'USER',
        // `?? null`, not the raw column: a fixture or a pre-migration row can
        // read as undefined, and the DTO promises a nullable string.
        avatarKey: target.avatarKey ?? null,
        imageUrl: this.avatarUrl(target.avatarKey ?? null),
        teamId,
        teamName: team?.name ?? null,
        teamIds: allMemberships.map((m) => m.teamId),
        manager: primaryManager,
        reportsTo,
        // T-ORG-OWNER-ACCESS (2026-09-17): OWNER/ADMIN see every project in
        // the org; staff see the projects linked to their resolved team.
        projects:
          target.role === 'OWNER' || target.role === 'ADMIN'
            ? (
                await client.project.findMany({
                  where: {
                    organizationId: actor.organizationId,
                    // T-SOFT-DELETE: same registry filter as the admin list
                    // branch - a deleted project is not one of "their" projects.
                    ...PROJECT_ACTIVE,
                  },
                  select: { id: true, name: true },
                  orderBy: { name: 'asc' },
                })
              ).map((p) => ({ id: p.id, name: p.name }))
            : (team?.projectTeams ?? []).map((pt) => ({
                id: pt.project.id,
                name: pt.project.name,
              })),
      };
    });
  }
}
