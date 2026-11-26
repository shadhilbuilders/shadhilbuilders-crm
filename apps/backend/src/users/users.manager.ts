// Reporting lines - who reports to whom (Round 67 split).
//
// The cycle and team-authority rules are the whole of this file; the read side
// that renders the same lines lives in ./users.directory.detail.ts.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { reportsToTeamManager } from '@shadhil/api-types';
import type { AssignManagerDto } from '@shadhil/api-types';
import { OWNER, assertCanChangeRole, assertCanCreateRole, isAdminClass, outranks } from './roles';
import { UsersBase } from './users.support';
import type { CreatedUser, UsersDeps } from './users.support';

export class UsersManager extends UsersBase {
  /**
   * PATCH /api/users/:id/manager - assign/reassign the reporting line for a
   * TELECALLER/SALES_EXEC/ENGINEER (autoplan 2026-09-13; ENGINEER 2026-11-07).
   * "Manager" is a reporting-line concept derived from `Team.managerId`, so
   * this sets the target's membership in the chosen team.
   *
   * TWO WRITE MODES, chosen by the TARGET's role:
   *
   *   - TELECALLER / SALES_EXEC -> MOVE. Replaces the target's ordinary
   *     TeamMember row(s) with one for the chosen team. Safe for these roles:
   *     their work comes from lead ownership, not team membership.
   *
   *   - ENGINEER -> ADDITIVE. Never deletes. An engineer's ENTIRE RLS surface
   *     (units, phases, progress photos) is derived from TeamMember ->
   *     ProjectTeam joins, so a move would silently revoke access to every
   *     project staffed by their previous team(s). Adding them to a second
   *     team is the normal way to give an engineer another project.
   *
   * Scope:
   *   - OWNER/ADMIN: assign to any existing (led) team.
   *   - MANAGER: only into their OWN team - they can't poach staff into
   *     another manager's team. In practice `getUser`'s scope check
   *     already means a MANAGER only reaches this for a user already in
   *     their own team, but the team-ownership check here is the actual
   *     gate (belt-and-braces, same pattern as `list()`'s where-clause
   *     comment). ENGINEER targets are further restricted to the admin class
   *     (below) - team membership IS the project-access grant.
   *   - staff: never - `outranks()` fails closed (RANK[staff] never
   *     exceeds RANK[staff]).
   */
  async assignManager(
    actor: JwtPayload,
    targetUserId: string,
    dto: AssignManagerDto,
  ): Promise<CreatedUser> {
    // 1-6 run inside ONE RLS transaction so the Team/TeamMember reads are
    // subject to the actor's GUCs (they are FORCE ROW LEVEL SECURITY) and
    // the membership replace + audit row commit atomically (AGENTS.md
    // A2/G-1: high-stakes action and its audit row in the SAME tx).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // Target must exist IN THIS ORG - same T-ORG-EXPLICIT rule as
      // `update()` and `changeRole()`. `User` has no RLS, so a bare
      // `findUnique({ id })` let an ADMIN in org A move a user in org B onto one
      // of org A's teams, which is a cross-tenant access grant (team membership
      // is what opens project access for an ENGINEER). The Team read below is
      // already safe: that table is FORCE RLS, so a foreign team id reads null.
      const target = await client.user.findFirst({
        where: { id: targetUserId, organizationId: actor.organizationId },
      });
      if (!target) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }

      // 1. Only team-linked staff report to a manager on this surface.
      //    2026-11-07: shared exhaustive rule - ENGINEER included.
      if (!reportsToTeamManager(target.role as Role)) {
        throw new BadRequestException('Only TELECALLER/SALES_EXEC/ENGINEER report to a manager');
      }

      // 1b. ENGINEER targets are admin-class only. Team membership IS the
      //     project-access grant for an engineer (TeamMember -> ProjectTeam
      //     under RLS), so letting a MANAGER use this endpoint would let them
      //     hand out site access - contradicting roles.ts's rule that ENGINEER
      //     provisioning is an admin act (assertCanCreateRole /
      //     assertCanChangeRole). The general outranks() check below would
      //     otherwise pass, because MANAGER (rank 2) outranks ENGINEER (1).
      const isEngineerTarget = target.role === 'ENGINEER';
      if (isEngineerTarget && !isAdminClass(actor.role)) {
        throw new ForbiddenException(
          `${actor.role} cannot change an ENGINEER's team - team membership grants site access, so this is OWNER/ADMIN only`,
        );
      }

      // 2. Hierarchy: actor must strictly outrank the target (mirrors
      //    update()/changeRole() - no self-service).
      if (!outranks(actor.role, target.role as Role)) {
        throw new ForbiddenException(`${actor.role} cannot reassign this user's manager`);
      }

      // 3. Target team must exist, be active, and have a manager -
      //    assigning into an unled team would make "manager" mean nothing.
      //    A soft-deleted team is treated as absent (mirrors
      //    teams.service.reassignMembers' active-team check) rather than
      //    silently accepted.
      const team = await client.team.findUnique({
        where: { id: dto.teamId },
        select: { id: true, name: true, managerId: true, deletedAt: true },
      });
      if (team === null || team.deletedAt !== null) {
        throw new NotFoundException(`Team ${dto.teamId} not found`);
      }
      if (team.managerId === null) {
        throw new BadRequestException(`Team "${team.name}" has no manager assigned yet`);
      }

      // 4. MANAGER scope: only into their own team.
      if (actor.role === 'MANAGER' && team.managerId !== actor.sub) {
        throw new ForbiddenException('Managers can only assign staff into their own team');
      }

      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): "assign into this
      // team" means "move them into the chosen team" for TELECALLER/
      // SALES_EXEC - this endpoint models a single-team move for those roles,
      // mirroring reassignMembers()'s move semantics.
      //
      // SCOPED MOVE (2026-09-13, partial-move fix): the delete is scoped to
      // the memberships the ACTOR can actually mutate, and the end state is
      // verified. Previously an unscoped `deleteMany({ userId })` ran, so for
      // a MANAGER every row on a team they do not lead was silently skipped
      // (RLS `USING` does not match an invisible row) while the call still
      // reported success - the "move" became an ADD and the user ended up in
      // two teams.
      const beforeTeamId = await this.resolveDisplayTeamId(
        client,
        target.id,
        target.role,
        actor.organizationId,
      );

      // A MANAGER can only see/delete rows on teams they lead. If the target
      // has no membership in such a team we cannot tell "belongs to no team"
      // from "belongs to ANOTHER manager's team" (RLS hides the latter, which
      // is exactly why this was silent), so fail closed instead of silently
      // adding them alongside an invisible membership.
      const currentMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
      });
      const beforeTeamIds = currentMemberships.map((m) => m.teamId).sort();

      if (isEngineerTarget) {
        // ── ENGINEER: ADDITIVE ────────────────────────────────────────────
        // Never delete. An engineer's whole RLS surface is TeamMember ->
        // ProjectTeam, so removing a membership revokes project access. Adding
        // a second team is how an engineer gets another project, and this
        // endpoint must not be able to take one away.
        if (beforeTeamIds.includes(dto.teamId)) {
          // Fail loudly instead of writing an audit row for a no-op.
          throw new ConflictException(
            `User ${target.id} is already a member of team ${dto.teamId}. Nothing was changed.`,
          );
        }

        await client.teamMember.create({
          data: {
            userId: target.id,
            teamId: dto.teamId,
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });

        // Additive invariant, same transaction: every membership that existed
        // before must still exist, and the destination must now be present.
        // This replaces the move-only "settled to exactly one" assertion -
        // without it the additive branch would be enforced by tests alone.
        const additiveAfter = await client.teamMember.findMany({
          where: { userId: target.id, organizationId: actor.organizationId },
          select: { teamId: true },
        });
        const afterTeamIds = additiveAfter.map((m) => m.teamId);
        const lost = beforeTeamIds.filter((id) => !afterTeamIds.includes(id));
        if (lost.length > 0 || !afterTeamIds.includes(dto.teamId)) {
          throw new ConflictException(
            `Could not add user ${target.id} to team ${dto.teamId} without disturbing their other teams (${lost.join(', ') || 'destination missing'}). No change was applied.`,
          );
        }

        await client.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.assignManager',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            // teamIds (plural) so the ADDED membership is visible - the
            // previous before/after teamId pair could not express "kept both".
            before: { teamIds: beforeTeamIds },
            after: { teamIds: [...afterTeamIds].sort() },
            reason: `engineer added to team by ${actor.email} (${actor.role})`,
          },
        });

        return {
          id: target.id,
          email: target.email,
          name: target.name,
          role: target.role,
          // Newest membership wins in resolveDisplayTeamId, so the team just
          // added is the one the response reports.
          teamId: dto.teamId,
        };
      }

      // ── TELECALLER / SALES_EXEC: MOVE (unchanged) ───────────────────────
      // Safe for these roles: their workload comes from lead ownership, not
      // from team membership.
      if (actor.role === 'MANAGER') {
        const managed = await client.team.findMany({
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
          select: { id: true },
        });
        const managedIds = managed.map((t) => t.id);
        const movable = currentMemberships.filter((m) => managedIds.includes(m.teamId));
        if (movable.length === 0) {
          throw new ForbiddenException(
            'This user is not in a team you manage, so you cannot move them. Ask an ADMIN, or use the team roster to add them.',
          );
        }
        // Delete only the rows on teams this manager leads. Being explicit
        // keeps the intent (and the audit) honest rather than relying on RLS
        // to silently narrow an unscoped delete.
        await client.teamMember.deleteMany({
          where: {
            userId: target.id,
            teamId: { in: managedIds },
            organizationId: actor.organizationId,
          },
        });
      } else {
        // ADMIN/OWNER can see and mutate every membership in the ORG, so the
        // full replace is both possible and intended. The org filter is explicit
        // here (T-ORG-EXPLICIT) rather than implied by RLS on TeamMember - the
        // comment above stated the org semantics before the query implemented
        // them.
        await client.teamMember.deleteMany({
          where: { userId: target.id, organizationId: actor.organizationId },
        });
      }

      await client.teamMember.create({
        data: {
          userId: target.id,
          teamId: dto.teamId,
          organizationId: actor.organizationId,
          assignedById: actor.sub,
        },
      });

      // Post-condition, same transaction: after the move the target must hold
      // exactly one membership and it must be the destination. A mismatch
      // means the move did not fully apply, so throw and let the transaction
      // roll back rather than leave the user in two teams. For a MANAGER this
      // asserts over the rows they can see (an unrelated team's membership
      // stays invisible - see the scoped-delete note above).
      const afterMemberships = await client.teamMember.findMany({
        where: { userId: target.id, organizationId: actor.organizationId },
        select: { teamId: true },
      });
      if (afterMemberships.length !== 1 || afterMemberships[0]?.teamId !== dto.teamId) {
        throw new ConflictException(
          `Could not move user ${target.id} cleanly into team ${dto.teamId} - the membership set did not settle to a single team. No change was applied.`,
        );
      }

      // 5. Audit row - same transaction, so a failed audit rolls back the
      //    membership move rather than leaving an unlogged change.
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.assignManager',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { teamId: beforeTeamId },
          after: { teamId: dto.teamId },
          reason: `manager reassigned by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        teamId: dto.teamId,
      };
    });
  }
}
