# ENGINEER reporting line ("Reports to") — implementation plan

**Date:** 2026-11-07
**Status:** Approved by plan review (gstack plan-eng-review)
**Branch of origin:** `feat/customer-progress-slice-2`
**Surfaces:** `apps/backend/src/users`, `apps/web/src/components/users`,
`apps/web/src/components/teams`, `packages/api-types`

---

## 1. What was actually wrong

`reportingTo` is not a column. It does not exist in the schema. "Reports to" is a
**derived read-time value**: resolve the user's `TeamMember` row → read that
`Team`'s `managerId` → load that `User`.

So nothing was "missed" on the write path. `POST /teams/:id/members` already
creates the very link the manager is derived from. What was missed is the
**read predicate**: the derivation is written as a *positive* role union

```
role === 'TELECALLER' || role === 'SALES_EXEC'
```

at three call sites, and `ENGINEER` — added later by issue #7 slice 1
(~2026-10-26) — is in none of them. `T-REPORTS-TO-OWNER` shipped 2026-10-06,
three weeks before `ENGINEER` existed.

### 1.1 Why the compiler did not catch it

Every other role rule in this codebase is enforced by an exhaustive map
(`RANK: Record<Role, number>` in `apps/backend/src/users/roles.ts:19`), so adding
a role is a build error. The reporting rule is a bare `===` union, so it fails
silently. That is the defect class, not the single omission.

### 1.2 Two surfaces already disagreed

| Surface | Predicate | ENGINEER result |
|---|---|---|
| `teams/team-roster.tsx:102` | negative (`MANAGER ? owner : managerName`) | **"Reports to Maya"** |
| `users.service.ts:730` (`getUser`) | positive union | `null` |
| `users.service.ts:1323` (`list`) | positive union | `null` |

Same user, two answers, depending which page you open.

```
                    Team.managerId  (Team, nullable)
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   GET /users           GET /users/:id        Team roster
   :1315 list()          :730 getUser()       team-roster.tsx:102
        │                     │                     │
   staffTeamIds =        reportsToManager =     MANAGER ? owner
   {TELECALLER,          {TELECALLER,                : managerName
    SALES_EXEC}           SALES_EXEC}
        │                     │                     │
   ENGINEER excluded     ENGINEER excluded     ENGINEER INCLUDED
   → reportsTo: null     → manager: null       → "Reports to Maya"
```

---

## 2. Decisions (all user-approved during review)

| ID | Decision | Rationale |
|---|---|---|
| **D2** | Derive from the linked team's manager. No `User.reportsToId` column, no migration, no backfill. | The team link already *is* the link. |
| **D3+D7** | `assignManager` accepts ENGINEER, **gated to ADMIN/OWNER only**. | Managers must not grant site access (`roles.ts:95`). |
| **D4** | One pure shared predicate, consumed by both apps. | Kills the copy-paste class of bug. |
| **D5+D8** | `assignManager` is **additive** for ENGINEER, and the resolve order prefers the **most recent** membership so the change is visible. | Additive alone is invisible: `resolveDisplayTeamId` returned the OLDEST row. |
| **D9** | `reassignMembers` **refuses** any request that would move an ENGINEER, naming them. UI hides "Move to team" on engineer rows. | Found while reviewing the implementation: this is the *other* door into the same data loss D5 closed. |
| **D10** | `orderBy: [{ assignedAt: 'desc' }, { teamId: 'asc' }]` at all four resolve sites. | `assignedAt` defaults to `now()`, which Postgres evaluates once per TRANSACTION - bulk inserts share a timestamp, so one sort key is nondeterministic. |

---

## 3. Why D5 needed D8 (the trap the first pass walked into)

`assignManager` today deletes **every** `TeamMember` row the target holds in the
org, inserts one, then asserts the set settled to exactly one:

```910:939:apps/backend/src/users/users.service.ts
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
      if (
        afterMemberships.length !== 1 ||
        afterMemberships[0]?.teamId !== dto.teamId
      ) {
```

For TELECALLER/SALES_EXEC this is correct — their work comes from lead
ownership. For ENGINEER it is destructive: their **entire** RLS surface is
derived from `TeamMember` → `ProjectTeam` joins:

```1853:1874:packages/database/prisma/rls/policies.sql
-- Slice-1 ENGINEER policies (mirror of migration 20261026160800 +
-- 20261027160000). These were deployed but missing from this canonical file;
-- mirrored verbatim in the slice-2 change so the file matches the database.
CREATE POLICY project_select_team_member ON "Project"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ENGINEER'
    AND EXISTS (
      SELECT 1 FROM "ProjectTeam" pt
      JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
```

So a two-team engineer "reassigned" would silently lose the first team's
projects. The audit payload records only `before.teamId` / `after.teamId`
(single strings), so the loss would not even appear in the log.

But making it additive alone is also wrong, because `resolveDisplayTeamId`
picks the **oldest** membership:

```137:142:apps/backend/src/users/users.service.ts
    const membership = await client.teamMember.findFirst({
      where: { userId, organizationId },
      orderBy: { assignedAt: 'asc' },
    });
    return membership?.teamId ?? null;
```

An additive insert of a *newer* team is therefore invisible — the endpoint
returns the new `teamId`, the toast reports success, and a refetch shows the old
manager. D8 fixes this: order by `assignedAt: 'desc'` so the newly-added
membership wins.

### 3.1 Accepted consequence of D8

Changing the resolve order affects **every** non-manager role, not just
ENGINEER. A SALES_EXEC on two teams will now display the manager of their
**newest** team instead of their oldest. This is the intended behaviour (the
most recently assigned team is the current one) but it is a behaviour change
for existing data and must be covered by a test, not discovered in production.

---

## 4. Implementation

### 4.1 New pure predicate — `packages/api-types/src/reporting.ts`

`apps/backend/src/users/roles.ts` imports `@nestjs/common`, so the web **cannot**
import it. `packages/api-types` is dependency-free (verified: no `@nestjs`
imports), which makes it the only correct home for a rule both apps apply.

```
reportingTargetFor(role: Role): 'TEAM_MANAGER' | 'ORG_OWNER' | 'NONE'
```

| Role | Result |
|---|---|
| TELECALLER, SALES_EXEC, ENGINEER | `TEAM_MANAGER` |
| MANAGER, ADMIN | `ORG_OWNER` |
| OWNER, CUSTOMER | `NONE` |

Returning a three-value target (not a boolean) also fixes `showReportsTo =
detail.role !== 'OWNER'` (`UserDetailView.tsx:143`), which today gives
**CUSTOMER** a bogus "No manager assigned" row, and the roster's negative check
at `team-roster.tsx:102` which has the same future-role failure.

Export from `packages/api-types/src/index.ts`.

### 4.2 Backend read sites

- `users.service.ts:730` — replace the union with
  `reportingTargetFor(target.role) === 'TEAM_MANAGER'`.
- `users.service.ts:1323` — same for the `staffTeamIds` map feeding the batched
  manager lookup.
- `users.service.ts:139` — `orderBy: { assignedAt: 'desc' }` (D8).
- `users.service.ts:1258` — the `list()` `take: 1` membership select also orders
  `asc`; flip to `desc` so list and detail agree.

### 4.3 `assignManager`

- Gate: `dto` role ENGINEER → require `isAdminClass(actor.role)` **before**
  the existing `outranks()` check. MANAGER gets `ForbiddenException` naming the
  reason (site-access grant), not a generic rank message.
- Branch the write on target role:
  - **TELECALLER / SALES_EXEC** — existing destructive move, unchanged.
  - **ENGINEER** — additive only: no `deleteMany`; `create` (or
    `createMany({ skipDuplicates: true })`) of the destination row. Replace the
    "settled to exactly one" assertion with an additive invariant verified in
    the same transaction: `before ⊆ after` **and** destination ∈ `after`.
- Audit: for the ENGINEER branch record `before: { teamIds: [...] }` and
  `after: { teamIds: [...] }` so the added membership is visible.
- Reject the no-op: if the target is already on `dto.teamId`, return a typed
  `ConflictException` ("already a member of this team") instead of writing an
  audit row for a change that did not happen.

### 4.4 Web

- `UserDetailView.tsx:53` — delete `REPORTS_TO_MANAGER`, use
  `reportingTargetFor(detail.role)` from `@shadhil/api-types`.
- `UserDetailView.tsx:143` — `showReportsTo = reportingTargetFor(role) !== 'NONE'`.
- `UserDetailView.tsx:294` — the picker must exclude **every** team the engineer
  already belongs to, not only `detail.teamId`.
- `team-roster.tsx:102` — same helper, killing the negative-check drift.
- Keep the button gated on `canManageUsers(actorRole)` (already admin-only, which
  now matches the backend after D7).

### 4.5 Stale contract text (same PR — these become lies otherwise)

- `packages/api-types/src/auth.ts:244-250` — `AssignManagerDtoSchema` doc still
  says TELECALLER/SALES_EXEC and references the deleted `User.teamId`.
- `packages/api-types/src/auth.ts:163-166` — `UserDetailSchema` manager rule.
- `apps/web/src/hooks/queries/users.ts:18-19` and `:234-235`.
- `apps/backend/src/users/users.controller.ts:144` — says "move".
- `apps/backend/src/users/users.service.ts:776, 809, 851` — move-only wording.
- `apps/web/src/components/users/UserDetailView.tsx:6-11` — header rule.

---

## 5. Tests

| # | Where | Assertion |
|---|---|---|
| T1 | `packages/api-types` | Table-driven over **every** `RoleSchema` value → expected target. Adding a role without a rule fails this test. This is the D4 guard. |
| T2 | `users.service.test.ts` (`reportsTo` block) | ENGINEER row resolves to team manager in `list()`. |
| T3 | `users.service.getUser.test.ts` | ENGINEER `manager` = team manager; CUSTOMER `manager` = null. |
| T4 | `users.service.assignManager.test.ts` | MANAGER actor + ENGINEER target → 403. ADMIN actor + ENGINEER target → 200. |
| T5 | `users.service.assignManager.test.ts` | ENGINEER already on destination team → `ConflictException`, no audit row. |
| T6 | `users.service.rls.test.ts` (**real DB**) | Two-team ENGINEER + additive assign: both rows survive, destination present, audit before/after lists both. Mocked tests cannot see RLS behaviour. |
| T7 | `users.service.test.ts` | **D8 regression:** two memberships `assignedAt` asc/desc → the newer team's manager is returned. Covers the SALES_EXEC behaviour change. |
| T8 | `UserDetailView.test.tsx` | ENGINEER shows "Reports to" + assign button; CUSTOMER shows neither. |
| T9 | `team-roster.test.tsx` | ENGINEER row shows the team manager. |
| T10 | `users.service.assignManager.test.ts` | Existing TELECALLER/SALES_EXEC move tests stay green — proves the destructive branch is untouched. |

**Iron rule:** T7 is a regression test for changed existing behaviour and cannot
be deferred.

---

## 6. NOT in scope

- **`User.reportsToId` column / migration / backfill** — declined in D2. Would
  answer the question most precisely (an HR reporting line is not the same thing
  as an RLS access grant) but costs a schema change the owner rejected.
- **Explicit "primary team" flag** — declined in D8/C. The honest fix for
  multi-team ambiguity; deferred to `TODOS.md`.
- **RLS policy changes** — none needed. ENGINEER already has membership-scoped
  policies.
- **`ProjectStaffRole(kind='PHOTO_LEAD')`** — project-level supervision is a
  different concept and does not become the reporting line.
- **`users.service.ts` size** (1,730 lines) — deferred to `TODOS.md`.
- **ENGINEER nav / role gating** — untouched.
- **Removing an engineer from a team** — `TeamMemberRemovalDialog` /
  remove-member is a DELIBERATE, labelled removal (not a "move"), so it is left
  as-is. D9 only blocks the path that looks like a label change but destroys
  access.
- **`canManageUsers` for a MANAGER viewer** — investigated and found NOT to be
  reachable: `UserDetailView` returns "Not authorized" unless
  `isAdminLike(user.role)`, so a MANAGER never renders the assign button at all.
  No change needed (an earlier draft added a redundant branch; reverted).

---

## 7. Delivery

Single PR, no migration. Order: T1 (helper + test) → T2/T3 (read sites) → T4/T5/T6
+ 4.3 (assignManager) → T7 (D8 order) → 4.4 (web) → 4.5 (docs).

**Parallelizable:** backend read sites (4.2) and web (4.4) are independent once
the helper exists. `assignManager` (4.3) touches the same file as 4.2, so keep
those sequential in one lane.

**Watch:** D8 flips team resolution order for every non-manager role. If any
surface depended on "oldest team wins", it moves. There are **four** membership
ordering sites in `users.service.ts`, not two — they must move together or the
surfaces re-diverge:

| Line | Method | What it resolves |
|---|---|---|
| 140 | `resolveDisplayTeamId` | `getUser` / `changeRole` display team |
| 1260 | `list` | Users table `teamId` + `reportsTo` |
| 1539 | `projectSalesExecs` | visit picker row `teamId` |
| 1697 | `teamMembers` | chat @mention picker `teamId` |

The `asc` orderings in `leads.service.ts` (810, 1417) and
`project-teams.service.ts` (75, 269) are different concepts (lead co-owner
ordering, project-team listing) and must NOT be touched.

## 8. Failure modes

| Path | Failure | Covered? |
|---|---|---|
| Additive ENGINEER assign | loses other memberships | T6 (real DB) + invariant in tx |
| Additive ENGINEER assign | succeeds but display unchanged | D8 order + T7 |
| assignManager | MANAGER grants site access | D7 gate + T4 |
| assignManager | no-op write + audit row for non-change | T5 |
| read sites | new role silently null again | T1 enum walk |
| Customer row | bogus "No manager assigned" | `reportingTargetFor` + T8 |
