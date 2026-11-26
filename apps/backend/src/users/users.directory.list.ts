// The staff directory - the list screen's query (Round 67 split).
//
// Filtering, ordering and pagination live here, including the phone search that
// has to match both the canonical stored digits and a partial run.

import { ForbiddenException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { reportingTargetFor, reportsToTeamManager } from '@shadhil/api-types';
import type { TeamReportingLine, UserFilterDto, UserListResult } from '@shadhil/api-types';
import { PROJECT_ACTIVE, PROJECT_TEAM_LIVE } from '../common/soft-delete-filters';
import { OWNER, findOrgOwner } from './roles';
import { UsersBase, searchPhoneTerms } from './users.support';
import type { UsersDeps } from './users.support';

export class UsersDirectoryList extends UsersBase {
  async list(
    actor: JwtPayload,
    filter: UserFilterDto = { limit: 50, offset: 0 },
  ): Promise<UserListResult> {
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): team scoping
    // resolves EVERY team via Team.managerId (a manager may lead multiple
    // teams) UNION the manager's own TeamMember rows, matching
    // TeamAccessService.getAccessibleTeamIds. OWNER and ADMIN see all. All
    // scopes exclude soft-deleted users. Membership is checked via the
    // TeamMember relation now - User.teamId is gone.
    //
    // One RLS transaction: the Team/ProjectTeam lookups below are FORCE
    // ROW LEVEL SECURITY, so on the bare client a MANAGER's team-scope
    // query returns [] and the where-clause degenerates to
    // `teamId IN ('__none__')` - i.e. an EMPTY user list for a manager who
    // demonstrably has team members. User itself has no RLS.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      let where: Record<string, unknown>;
      // Multiple optional filters each want `OR` (project scope, search). They
      // are accumulated here and ANDed together at the end, because a plain
      // `where.OR = ...` assignment silently replaces whatever set it before.
      const andClauses: Record<string, unknown>[] = [];
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
        // T-USER-PROJECT-SCOPE: this branch used to be `{ deletedAt: null }` with
        // NO tenant filter, so it listed users from EVERY organisation. The org
        // is the outer boundary of visibility - scope it here regardless of what
        // else the caller asked for.
        where = { deletedAt: null, organizationId: actor.organizationId };
      } else if (actor.role === 'MANAGER') {
        const teams = await client.team.findMany({
          // T-ORG-EXPLICIT: scope the team lookup by org too. `Team` is
          // org-scoped, so teamIds were already org-bounded in practice - but
          // relying on that implicitly means an RLS policy change silently turns
          // this into a cross-org read. The org is a top-level key on every
          // branch, never an incidental consequence of a join.
          where: {
            managerId: actor.sub,
            deletedAt: null,
            organizationId: actor.organizationId,
          },
        });
        const teamIds = teams.map((t) => t.id);
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          teamMemberships:
            teamIds.length > 0
              ? { some: { teamId: { in: teamIds } } }
              : { some: { teamId: '__none__' } },
        };
      } else {
        where = {
          deletedAt: null,
          organizationId: actor.organizationId,
          id: actor.sub,
        };
      }

      // T-USER-PROJECT-SCOPE (2026-09-16): narrow to staff of ONE project.
      // INTERSECTION with everything above - it can only ever REDUCE the list, so
      // a manager still sees only their own team and a telecaller still sees only
      // themselves. Source of truth is project STAFFING (ProjectTeam = the
      // project<->team link): members of a staffed team, plus the managers of
      // those teams. The actor's OWN row is always kept so a picker can never
      // hide the current owner from a filter they triggered.
      if (filter.projectId !== undefined) {
        // T-ORG-EXPLICIT: validate the caller-supplied projectId against the
        // actor's org, and fail LOUDLY. `Project`/`ProjectTeam` RLS allow any
        // authenticated role, so RLS does bound this - but it bounds it by
        // returning ZERO rows, which is indistinguishable from "this project has
        // no staff" and therefore reports a cross-org probe as an empty picker.
        // An explicit 403 makes the boundary observable.
        const project = await client.project.findFirst({
          where: {
            id: filter.projectId,
            organizationId: actor.organizationId,
            ...PROJECT_ACTIVE,
          },
          select: { id: true },
        });
        if (project === null) {
          throw new ForbiddenException('Project not found in your organization');
        }

        const projectTeams = await client.projectTeam.findMany({
          where: {
            projectId: filter.projectId,
            organizationId: actor.organizationId,
          },
          select: { teamId: true },
        });
        const staffedTeamIds = projectTeams.map((pt) => pt.teamId);
        const staffedTeams =
          staffedTeamIds.length > 0
            ? await client.team.findMany({
                where: { id: { in: staffedTeamIds }, deletedAt: null },
                select: { managerId: true },
              })
            : [];
        const staffedManagerIds = staffedTeams
          .map((t) => t.managerId)
          .filter((id): id is string => id !== null);

        const projectScope: Record<string, unknown>[] = [];
        if (staffedTeamIds.length > 0) {
          projectScope.push({
            teamMemberships: { some: { teamId: { in: staffedTeamIds } } },
          });
        }
        if (staffedManagerIds.length > 0) {
          projectScope.push({ id: { in: staffedManagerIds } });
        }
        // Always include the actor, so "assign to me" style flows keep working
        // and the current owner is never silently filtered out.
        projectScope.push({ id: actor.sub });

        // NOTE: `OR` is a single key, so it must NOT be re-assigned by the search
        // block later in this method - that would silently drop the project
        // scope. Collected into `andClauses` and combined once, below.
        andClauses.push({ OR: projectScope });
      }

      // Assignee pickers: only users who can take work (not banned).
      // `banned` is nullable, so match false OR null.
      if (filter.availableOnly === true) {
        andClauses.push({ OR: [{ banned: false }, { banned: null }] });
      }

      // Server-driven role filter (autoplan 2026-09-09): the UI's MultiSelect
      // sends ?role=SALES_EXEC,TELECALLER; apply it as a WHERE role IN (...)
      // so filtering works across the whole list, not just the loaded page.
      if (filter.role !== undefined) {
        const roles = Array.isArray(filter.role) ? filter.role : [filter.role];
        where = { ...where, role: { in: roles } };
      }

      // Server-side search (autoplan 2026-09-09): the toolbar search input
      // sends ?search=...; match name OR email case-insensitively so search
      // works across the whole list, not just the loaded page.
      //
      // 2026-11-18: also match `phone`, and match it in BOTH shapes.
      //
      // The column stores digits only (`919876543210`), so a plain `contains`
      // would miss every natural way an operator types a number - "98765
      // 43210", "+91 98765 43210", "098765 43210". The term is normalized
      // through the same helper the write path uses, and the RAW term is kept
      // as a second alternative so a partial digit run still matches mid-string
      // (searching "7654" must not be turned into a full-number parse failure).
      if (filter.search !== undefined && filter.search.length > 0) {
        const phoneTerms = searchPhoneTerms(filter.search);
        andClauses.push({
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' } },
            { email: { contains: filter.search, mode: 'insensitive' } },
            ...phoneTerms.map((term) => ({ phone: { contains: term } })),
          ],
        });
      }

      // Combine every accumulated optional filter with AND.
      if (andClauses.length > 0) {
        where = { ...where, AND: andClauses };
      }

      // Server-side pagination (T-SRVPG, mirrors leads): the DataTable
      // paginates client-side over the loaded page, which is wrong for large
      // sets. The page passes limit/offset and the service applies them in the
      // SQL, returning { rows, total } so the pagination control stays honest.
      const [rows, total] = await Promise.all([
        client.user.findMany({
          where,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            // 2026-11-24: the photo key. Always selected (unlike phone, which is
            // opt-in): a face is how staff recognise a colleague in a list, and a
            // key is not PII in the sense a mobile number is. Resolved to a URL in
            // the mapping below with no I/O - the provider's public base is a
            // string build, so a page of rows costs nothing.
            avatarKey: true,
            // 2026-11-18: opt-in (see UserFilterDto.includePhone). Excluded by
            // default because this same payload backs six picker surfaces that
            // have no reason to see staff mobiles.
            ...(filter.includePhone === true ? { phone: true } : {}),
            // CUSTOMER rows have no phone of their own; theirs is DERIVED from
            // the lead below. Selecting the pointer here keeps that to one
            // batched read per page instead of a query per row.
            ...(filter.includePhone === true ? { customerLeadId: true } : {}),
            // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): the NEWEST
            // TeamMember row is this row's "display team" for non-managers
            // (resolveDisplayTeamId's rule) - a MANAGER's team is resolved
            // separately below via Team.managerId.
            // 2026-11-07 (D8): was 'asc'; flipped so a newly added membership
            // is visible in the table instead of the first team ever joined.
            // teamId tie-break: identical assignedAt is possible within one
            // transaction (see resolveDisplayTeamId).
            teamMemberships: {
              select: { teamId: true },
              orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
              take: 1,
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: filter.offset,
          take: filter.limit,
        }),
        client.user.count({ where }),
      ]);

      // Resolve MANAGER rows' teams via Team.managerId (batched: fetch every
      // team led by any manager on this page, pick the oldest per manager -
      // matches resolveDisplayTeamId's single-row rule).
      const managerIds = rows.filter((r) => r.role === 'MANAGER').map((r) => r.id);
      const ledTeams =
        managerIds.length > 0
          ? await client.team.findMany({
              where: { managerId: { in: managerIds }, deletedAt: null },
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

      const resolvedTeamIds = rows.map(
        (r) =>
          (r.role === 'MANAGER' ? ledTeamByManagerId.get(r.id) : r.teamMemberships[0]?.teamId) ??
          null,
      );

      // Project names for the admin Users table (autoplan 2026-09-12).
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): a user's projects
      // are "whichever projects this user's resolved TEAM is linked to"
      // (ProjectTeam) - ProjectMember (per-user linking) was retired.
      // Batched: fetch ProjectTeam rows for every resolved team id at once.
      const uniqueTeamIds = Array.from(
        new Set(resolvedTeamIds.filter((id): id is string => id !== null)),
      );
      const projectTeams =
        uniqueTeamIds.length > 0
          ? await client.projectTeam.findMany({
              where: { teamId: { in: uniqueTeamIds }, ...PROJECT_TEAM_LIVE },
              select: { teamId: true, project: { select: { name: true } } },
              orderBy: { project: { name: 'asc' } },
            })
          : [];
      const projectNamesByTeamId = new Map<string, string[]>();
      for (const pt of projectTeams) {
        const list = projectNamesByTeamId.get(pt.teamId) ?? [];
        list.push(pt.project.name);
        projectNamesByTeamId.set(pt.teamId, list);
      }

      // "Reports to" (2026-10-08, pluralised 2026-11-07). The per-team
      // single-manager batch that used to live here was replaced by the
      // multi-line builder below, which needs the membership rows anyway (the
      // old code derived teams from `resolvedTeamIds[i]`, i.e. only the DISPLAY
      // team, which is exactly the lossiness this decision fixes).
      //
      // 2026-11-07: shared rule (was an inline MANAGER/ADMIN union).
      const needsOwner = rows.some((r) => reportingTargetFor(r.role as Role) === 'ORG_OWNER');
      const orgOwner = needsOwner ? await findOrgOwner(client, actor.organizationId) : null;

      // ── Multi-line "Reports to" (2026-11-07 product decision) ─────────────
      // A staff member on two teams reports to two managers. The single
      // `reportsTo` collapsed that to the newest team's manager, so an admin
      // had no way to learn the other line existed. Built here with ONE batched
      // membership query for the whole page (not per row) plus ONE team query,
      // so paging 50 users costs the same two round trips as before.
      const reportingLineUserIds = rows
        .filter((r) => reportsToTeamManager(r.role as Role))
        .map((r) => r.id);
      const reportingLinesByUserId = new Map<string, TeamReportingLine[]>();
      if (reportingLineUserIds.length > 0) {
        const membershipRows = await client.teamMember.findMany({
          where: { userId: { in: reportingLineUserIds }, organizationId: actor.organizationId },
          // Same tie-break as resolveDisplayTeamId: `assignedAt` defaults to
          // now(), evaluated once per transaction, so bulk inserts can share a
          // timestamp and a single sort key would flip between reads.
          orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }],
          select: {
            userId: true,
            teamId: true,
            team: {
              select: {
                name: true,
                deletedAt: true,
                manager: { select: { id: true, name: true, email: true } },
              },
            },
          },
        });
        for (const m of membershipRows) {
          // A soft-deleted team grants no access, so it is not a line to show.
          if (m.team.deletedAt !== null) continue;
          const list = reportingLinesByUserId.get(m.userId) ?? [];
          list.push({ teamId: m.teamId, teamName: m.team.name, manager: m.team.manager });
          reportingLinesByUserId.set(m.userId, list);
        }
      }
      // ORG_OWNER roles get the fixed single line; NONE gets an empty array.
      const ownerLine: TeamReportingLine[] =
        orgOwner === null ? [] : [{ teamId: '', teamName: 'Organisation', manager: orgOwner }];

      // T-ORG-OWNER-ACCESS (2026-09-17): OWNER and ADMIN see EVERY project in
      // the org, not just the (empty) set linked to their team. OWNER/ADMIN
      // carry no team (teamId null -> the team-linked map yields an empty
      // list), yet RLS already grants them the org-wide Project registry, so
      // show the full org project names for admin-class rows.
      const adminRoles = new Set(['OWNER', 'ADMIN']);
      const adminRowIndexes = rows
        .map((r, i) => (adminRoles.has(r.role) ? i : -1))
        .filter((i) => i >= 0);
      // One batched fetch of the org's projects, filtered to the name list we
      // already use for the team-linked rows (same shape, same orderBy).
      let orgProjectNames: string[] = [];
      if (adminRowIndexes.length > 0) {
        const orgRows = await client.project.findMany({
          where: {
            organizationId: actor.organizationId,
            // T-SOFT-DELETE: the admin/owner Projects column is the org
            // registry, so it must match the registry's own filter. Without
            // this a soft-deleted project stayed visible as "1 project"
            // (reported 2026-10-01).
            ...PROJECT_ACTIVE,
          },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        orgProjectNames = orgRows.map((p) => p.name);
      }

      // ── Phone for the admin Users table (2026-11-18) ──────────────────────
      // Opt-in. Staff read their own column; a CUSTOMER has NO phone of their
      // own (the account never stores one), so theirs is DERIVED from the lead
      // they are linked to. One batched lead read per page, not a query per
      // row - same shape as ledTeams above, so paging costs stay unchanged.
      //
      // A customer whose lead is missing reads as null, which the table renders
      // as an em dash. Blank is honest here; inventing a value would not be.
      const phoneByUserId = new Map<string, { phone: string | null; source: 'USER' | 'LEAD' }>();
      if (filter.includePhone === true) {
        const leadIds = rows
          .map((r) => (r.role === 'CUSTOMER' ? (r.customerLeadId ?? null) : null))
          .filter((id): id is string => id !== null);
        const leadPhones =
          leadIds.length > 0
            ? await client.lead.findMany({
                where: { id: { in: leadIds }, organizationId: actor.organizationId },
                select: { id: true, phone: true },
              })
            : [];
        const phoneByLeadId = new Map(leadPhones.map((l) => [l.id, l.phone] as const));
        for (const r of rows) {
          if (r.role === 'CUSTOMER') {
            const leadPhone =
              r.customerLeadId != null ? (phoneByLeadId.get(r.customerLeadId) ?? null) : null;
            phoneByUserId.set(r.id, { phone: leadPhone, source: 'LEAD' });
          } else {
            phoneByUserId.set(r.id, { phone: r.phone ?? null, source: 'USER' });
          }
        }
      }

      return {
        rows: rows.map((r, i) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          role: r.role,
          avatarKey: r.avatarKey ?? null,
          // Resolved here, not in the browser: the same rule GET /users/:id uses,
          // so the list and the detail page cannot disagree about the URL.
          imageUrl: this.avatarUrl(r.avatarKey ?? null),
          teamId: resolvedTeamIds[i] ?? null,
          // Only present when includePhone was requested; omitting the keys
          // entirely keeps every other picker's payload byte-identical.
          ...(filter.includePhone === true
            ? {
                phone: phoneByUserId.get(r.id)?.phone ?? null,
                phoneSource: phoneByUserId.get(r.id)?.source,
              }
            : {}),
          // 2026-11-07: exhaustive reporting map. MANAGER/ADMIN -> org OWNER;
          // OWNER/CUSTOMER -> nobody; everyone else -> one line per team.
          reportsTo: (() => {
            const target = reportingTargetFor(r.role as Role);
            if (target === 'NONE') return [];
            if (target === 'ORG_OWNER') return ownerLine;
            return reportingLinesByUserId.get(r.id) ?? [];
          })(),
          // Deprecated single-value companion (one release). The first entry's
          // manager keeps any client still reading the old field working; the
          // new UI reads `reportsTo`.
          reportsToPrimary: (() => {
            const target = reportingTargetFor(r.role as Role);
            if (target === 'NONE') return null;
            if (target === 'ORG_OWNER') return orgOwner;
            return (reportingLinesByUserId.get(r.id) ?? [])[0]?.manager ?? null;
          })(),
          // Admin-class rows expose the full org project set; everyone else
          // reflects the projects linked to their resolved team.
          projects: adminRoles.has(r.role)
            ? orgProjectNames
            : (projectNamesByTeamId.get(resolvedTeamIds[i] ?? '') ?? []),
        })),
        total,
      };
    });
  }
}
