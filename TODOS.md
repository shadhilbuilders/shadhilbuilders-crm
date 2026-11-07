# TODOS

Deferred work captured by plan reviews. Organised by component; items sorted
P0 first. Format reference: `~/.cursor/skills/gstack/review/TODOS-format.md`.

## Users / Teams

### Multi-team ENGINEER shows the manager of their oldest team, not the one they work with

**What:** Decide and implement how "Reports to" is resolved when a staff member
holds more than one `TeamMember` row.

**Why:** `resolveDisplayTeamId` (`apps/backend/src/users/users.service.ts:139`)
returns the OLDEST `TeamMember` row by `assignedAt`. So a person on two teams
displays the manager of whichever team they joined first, even if that is not
the team they actually work in. This is already true for SALES_EXEC, but it
becomes visible for ENGINEER as soon as the reporting-line predicate includes
them (they are routinely on more than one team via `POST /teams/:id/members`,
which is additive). The display will also disagree with the access they
actually have: ENGINEER RLS covers EVERY team they belong to
(`packages/database/prisma/rls/policies.sql:1853+`), so they can see two
projects while "Reports to" names one manager.

**Context:** The single-team assumption predates multi-team support
(T-TEAM-AUTHORITATIVE, 2026-09-13, Decision Audit Trail #39/#40). Every legacy
response shape (`CreatedUser.teamId`, `UserDetail.teamId`, `UserListResult`
`reportsTo`) still collapses N memberships to one. Options: (a) report the
managers of ALL teams (change the field to an array - a breaking api-types
change touching `packages/api-types/src/auth.ts` and both web surfaces),
(b) keep one manager but let the admin pick which team is "primary"
(adds a column + a UI affordance), (c) leave it and document the
oldest-row rule. No decision has been made. Start by reading
`resolveDisplayTeamId` and its four callers.

**Effort:** M
**Priority:** P2
**Depends on:** The ENGINEER reporting-line fix landing first (otherwise the
ambiguity is invisible and untestable).

### users.service.ts is 1,730 lines and mixes six concerns

**What:** Split `apps/backend/src/users/users.service.ts` along concern
boundaries (list/get, create/changeRole, assignManager, password, profile).

**Why:** The file is more than double the 800-line ceiling in
`~/.cursor/rules/common-coding-style.mdc`. The reporting-line rule was missed
partly because it is duplicated at three separate points inside this one file
(lines 730, 810, 1323) with no shared helper, so nothing forced them to agree.

**Context:** The reporting-line fix extracts `reportsToTeamManager(role)` and
uses it at those sites, which removes the duplication but not the size. This
entry is specifically about file structure. Note that `assignManager` carries
subtle semantics (scoped delete, post-condition assertion, single-transaction
audit) with long inline comments explaining past bugs - moving it needs those
comments preserved verbatim and its tests (`users.service.assignManager.test.ts`,
`users.service.rls.test.ts`) kept green. Do NOT combine this with behavioural
changes; mechanical extraction only.

**Effort:** L
**Priority:** P3
**Depends on:** None — but land it separately from any behaviour change.

## Completed
