// TeamAccessService - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit
// Trail #39 in docs/planning/IMPLEMENTATION-PLAN-v1.md).
//
// The SOLE backend source for "which teams can this actor see/manage" and
// "which projects does this actor have access to" under the team-
// authoritative staffing model. Every feature service that needs a
// membership/management predicate calls into this service instead of
// re-deriving `TeamMember`/`Team.managerId`/`ProjectTeam` joins inline -
// keeps the access rules in exactly one place (plan Dependencies section).
//
// Transaction-bound: every method takes the SAME `tx` a caller already has
// open inside its own `withRlsContext` call (never opens a second
// transaction), so RLS session vars (`app.user_id`, `app.user_org_id`, ...)
// stay in scope for the queries this service issues on the caller's behalf.
//
// This service reads ONLY from the new `TeamMember` / `ProjectTeam` tables
// (backfilled by migration 20260913010000) and is now the shared access API
// every team-scoped controller/service consumes - membership predicates are
// not inlined ad hoc anywhere else.

import { Injectable } from '@nestjs/common';
import type { Role, RlsTx } from '@shadhil/database';

import { isAdminClass } from '../users/roles';

export interface AccessActor {
  sub: string;
  role: Role;
  organizationId?: string | null;
}

@Injectable()
export class TeamAccessService {
  /**
   * Team ids the actor MANAGES (Team.managerId === actor, active teams
   * only). Independent of role - an ADMIN could theoretically also be set
   * as a Team.managerId, though in practice only MANAGER accounts are
   * assigned there (teams.service.ts enforces that at write time).
   */
  async getManagedTeamIds(tx: RlsTx, userId: string): Promise<string[]> {
    const rows = await tx.team.findMany({
      where: { managerId: userId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Team ids the actor is an ORDINARY member of, via the additive
   * `TeamMember` join. Does NOT include teams they merely manage (a
   * manager only gets a `TeamMember` row for a team when they ALSO serve
   * as an ordinary member of a DIFFERENT team than the one(s) they lead -
   * see the model comment on `TeamMember` in schema.prisma).
   */
  async getOrdinaryMemberTeamIds(tx: RlsTx, userId: string): Promise<string[]> {
    const rows = await tx.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      select: { teamId: true },
    });
    return rows.map((r) => r.teamId);
  }

  /**
   * Every team id the actor can see/act within, respecting the design
   * doc's authorization matrix:
   *   - OWNER/ADMIN: every team in the org.
   *   - MANAGER: teams they manage UNION teams they ordinarily belong to.
   *   - Other staff (TELECALLER/SALES_EXEC): teams they ordinarily belong to.
   */
  async getAccessibleTeamIds(tx: RlsTx, actor: AccessActor): Promise<string[]> {
    if (isAdminClass(actor.role)) {
      const rows = await tx.team.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }

    const [managed, member] = await Promise.all([
      this.getManagedTeamIds(tx, actor.sub),
      this.getOrdinaryMemberTeamIds(tx, actor.sub),
    ]);
    return Array.from(new Set([...managed, ...member]));
  }

  /**
   * Team ids the actor may MUTATE membership for (add/remove a
   * `TeamMember`, run the removal flow). Per the authorization matrix:
   * OWNER/ADMIN -> any org team; MANAGER -> only teams they manage;
   * everyone else -> none.
   */
  async getMutableTeamIds(tx: RlsTx, actor: AccessActor): Promise<string[]> {
    if (isAdminClass(actor.role)) {
      const rows = await tx.team.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    if (actor.role === 'MANAGER') {
      return this.getManagedTeamIds(tx, actor.sub);
    }
    return [];
  }

  /** True iff the actor may mutate membership on `teamId` (see above). */
  async canMutateTeam(tx: RlsTx, actor: AccessActor, teamId: string): Promise<boolean> {
    if (isAdminClass(actor.role)) return true;
    if (actor.role !== 'MANAGER') return false;
    const managed = await this.getManagedTeamIds(tx, actor.sub);
    return managed.includes(teamId);
  }

  /**
   * Project ids derived from `ProjectTeam` for the given team ids (the
   * "linking a team to a project changes derived project staff" success
   * criterion). Callers combine this with `getAccessibleTeamIds` to get an
   * actor's full accessible-project set.
   */
  async getProjectIdsForTeams(tx: RlsTx, teamIds: string[]): Promise<string[]> {
    if (teamIds.length === 0) return [];
    const rows = await tx.projectTeam.findMany({
      where: { teamId: { in: teamIds } },
      select: { projectId: true },
    });
    return Array.from(new Set(rows.map((r) => r.projectId)));
  }

  /** Every project id the actor has access to, via their accessible teams. */
  async getAccessibleProjectIds(tx: RlsTx, actor: AccessActor): Promise<string[]> {
    if (isAdminClass(actor.role)) {
      const rows = await tx.project.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    const teamIds = await this.getAccessibleTeamIds(tx, actor);
    return this.getProjectIdsForTeams(tx, teamIds);
  }
}
