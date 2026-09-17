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
  /**
   * T-ORG-EXPLICIT (2026-09-16): REQUIRED for every scoping call. It was
   * optional, so the org could be silently absent and every query in this
   * authorization module fell back to "no org filter" - i.e. an admin-class
   * actor resolved teams/projects across orgs.
   */
  organizationId: string;
}

/**
 * T-ORG-EXPLICIT: fail loudly rather than run an unscoped authorization query. A
 * missing org must never degrade into "no filter" - that turns a scoping bug into
 * a cross-tenant grant.
 */
function requireOrg(actor: AccessActor): string {
  if (typeof actor.organizationId !== 'string' || actor.organizationId.length === 0) {
    throw new Error('AccessActor.organizationId is required for team/project scoping');
  }
  return actor.organizationId;
}

@Injectable()
export class TeamAccessService {
  /**
   * Team ids the actor MANAGES (Team.managerId === actor, active teams
   * only). Independent of role - an ADMIN could theoretically also be set
   * as a Team.managerId, though in practice only MANAGER accounts are
   * assigned there (teams.service.ts enforces that at write time).
   */
  async getManagedTeamIds(
    tx: RlsTx,
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await tx.team.findMany({
      // T-ORG-EXPLICIT: `managerId` alone is NOT org-unique (a user id from one
      // org can only exist in that org, but relying on an RLS policy to imply the
      // boundary means a policy change silently widens this). The org is an
      // explicit key on every team lookup in this file.
      where: { managerId: userId, deletedAt: null, organizationId },
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
  async getOrdinaryMemberTeamIds(
    tx: RlsTx,
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await tx.teamMember.findMany({
      // T-ORG-EXPLICIT: filter the denormalized org COLUMN rather than relying on
      // the `team` join for tenancy - that is exactly why the column exists.
      where: { userId, organizationId, team: { deletedAt: null } },
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
    const organizationId = requireOrg(actor);
    if (isAdminClass(actor.role)) {
      const rows = await tx.team.findMany({
        // T-ORG-EXPLICIT: "every team in the org" stated in the doc comment.
        where: { deletedAt: null, organizationId },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }

    const [managed, member] = await Promise.all([
      this.getManagedTeamIds(tx, actor.sub, organizationId),
      this.getOrdinaryMemberTeamIds(tx, actor.sub, organizationId),
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
    const organizationId = requireOrg(actor);
    if (isAdminClass(actor.role)) {
      const rows = await tx.team.findMany({
        where: { deletedAt: null, organizationId },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    if (actor.role === 'MANAGER') {
      return this.getManagedTeamIds(tx, actor.sub, organizationId);
    }
    return [];
  }

  /** True iff the actor may mutate membership on `teamId` (see above). */
  async canMutateTeam(tx: RlsTx, actor: AccessActor, teamId: string): Promise<boolean> {
    const organizationId = requireOrg(actor);
    // T-ORG-EXPLICIT: this returned `true` for an admin on ANY teamId without
    // ever touching the database - an authorization answer that did not depend on
    // the tenant. Resolve the team and require it to be in the actor's org. RLS
    // would hide a foreign team, but "hidden" and "allowed" are different
    // answers, and this method's whole job is to give the second one.
    if (isAdminClass(actor.role)) {
      const team = await tx.team.findFirst({
        where: { id: teamId, deletedAt: null, organizationId },
        select: { id: true },
      });
      return team !== null;
    }
    if (actor.role !== 'MANAGER') return false;
    const managed = await this.getManagedTeamIds(tx, actor.sub, organizationId);
    return managed.includes(teamId);
  }

  /**
   * Project ids derived from `ProjectTeam` for the given team ids (the
   * "linking a team to a project changes derived project staff" success
   * criterion). Callers combine this with `getAccessibleTeamIds` to get an
   * actor's full accessible-project set.
   */
  async getProjectIdsForTeams(
    tx: RlsTx,
    teamIds: string[],
    organizationId: string,
  ): Promise<string[]> {
    if (teamIds.length === 0) return [];
    const rows = await tx.projectTeam.findMany({
      // T-ORG-EXPLICIT: filter the denormalized org column directly.
      where: { teamId: { in: teamIds }, organizationId },
      select: { projectId: true },
    });
    return Array.from(new Set(rows.map((r) => r.projectId)));
  }

  /** Every project id the actor has access to, via their accessible teams. */
  async getAccessibleProjectIds(tx: RlsTx, actor: AccessActor): Promise<string[]> {
    const organizationId = requireOrg(actor);
    if (isAdminClass(actor.role)) {
      const rows = await tx.project.findMany({
        where: { deletedAt: null, organizationId },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    const teamIds = await this.getAccessibleTeamIds(tx, actor);
    return this.getProjectIdsForTeams(tx, teamIds, organizationId);
  }
}
