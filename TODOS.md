# TODOS

Deferred work captured by plan reviews. Organised by component; items sorted
P0 first. Format reference: `~/.cursor/skills/gstack/review/TODOS-format.md`.

## Users / Teams

### Multi-team ENGINEER shows the manager of their newest team, not a per-team breakdown

**What:** Decide and implement how "Reports to" is resolved when a staff member
holds more than one `TeamMember` row.

**Why:** `resolveDisplayTeamId` (`apps/backend/src/users/users.service.ts:139`)
returns the NEWEST `TeamMember` row by `assignedAt` (D8, 2026-11-07; it was
OLDEST before that). So a person on two teams displays exactly one manager -
the most recently assigned team's. That is defensible but lossy: their ENGINEER
RLS access covers EVERY team they belong to
(`packages/database/prisma/rls/policies.sql:1853+`), so they can see two
projects while "Reports to" names one manager. It also changed existing
behaviour for SALES_EXEC, who now show their newest team instead of their
first.

**Context:** The single-team assumption predates multi-team support
(T-TEAM-AUTHORITATIVE, 2026-09-13, Decision Audit Trail #39/#40). Every legacy
response shape (`CreatedUser.teamId`, `UserDetail.teamId`, `UserListResult`
`reportsTo`) still collapses N memberships to one. Options: (a) report the
managers of ALL teams (change the field to an array - a breaking api-types
change touching `packages/api-types/src/auth.ts` and both web surfaces),
(b) keep one manager but let the admin pick which team is "primary"
(adds a column + a UI affordance), (c) leave it and document the
newest-row rule. No decision has been made. Start by reading
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

### Team resolution order diverges between "display" and "lead creation default"

**What:** Decide whether lead creation should default to the NEWEST team, like
every display surface now does.

**Why:** `resolveDisplayTeamId` and the three other display resolvers use
`assignedAt: 'desc'` (newest wins) since 2026-11-07. Lead creation
(`apps/backend/src/leads/leads.service.ts:805-810`) still defaults to the
**oldest** membership when `dto.teamId` is omitted. A telecaller on two teams
therefore sees Team B on their profile while new leads they create land in
Team A. This is not a bug in either place - they answer different questions
("which team identifies me" vs "which team's pipeline do I feed") - but nobody
has decided that, so it reads as an inconsistency.

**Context:** Both call sites are now commented with their ordering rule. Before
changing lead creation, confirm which is intended with the owner: the newest
team is the most recently assigned (probably current), but the oldest may be
the primary posting. A lead created into the wrong team is still owned by the
actor, so the blast radius is routing/reporting, not access. Start by reading
`leads.service.ts:805` and `users.service.ts:137`.

**Effort:** S
**Priority:** P3
**Depends on:** None; needs a product decision, not code.

## Customer progress (photos)

### The photo-lead grant has no route to use it

**What:** Build the photo edit and delete endpoints (and their UI controls) that
`ProjectStaffRole(kind='PHOTO_LEAD')` exists to authorize.

**Why:** The authority is real in the database and invisible in the product.
`progress_photo_update` and `progress_photo_delete` (migration
`20261026160800`, mirrored in `policies.sql` since 2026-11-07) both grant
ADMIN, the creator, or the project's photo lead. But there is **no** `@Delete`
or `@Patch` anywhere in `apps/backend/src/customer-progress/`, and the only
`progressPhoto.update/delete` calls in the repo are backfill scripts
(`scripts/backfill-media-mime.ts:337`, `scripts/migrate-local-media.ts:320`).
So an admin flips the "Photo lead" switch, gets a success toast, and nothing
changes for anybody. Every support ticket on this feature will read "the toggle
does nothing", and it will be correct.

**Context:** Slice 1 shipped upload + read only; the grant was seeded
(`manager@shadhilbuilders.in` holds PHOTO_LEAD on Metro Heights) and the toggle
was wired, but the consuming routes were deferred to slice 2. Before building
them, note three things: (1) the RLS arms already exist, so this is a service +
controller + UI job, not a policy job; (2) `progress_photo_select_customer`
exists for the buyer portal, so a delete must consider what a buyer has already
seen; (3) `setPhotoLead` now refuses a GRANT to someone not staffed on the
project (2026-11-07) but deliberately still allows REVOKE, so a stale grant can
be cleared. Start at `apps/backend/src/customer-progress/customer-progress.controller.ts`.

**Effort:** M
**Priority:** P2
**Depends on:** Nothing, but land it with the UI control or the gap just moves.

### The photo-lead toggle only renders on ENGINEER rows

**What:** Decide whether non-engineer photo leads should be toggleable in the UI,
or whether non-engineer grants should be prevented.

**Why:** `project-team-list.tsx:237` gates the switch on `m.role === 'ENGINEER'`,
but the endpoint and RLS accept any staffed user. The seeded demo data already
grants PHOTO_LEAD to a **MANAGER**, whose row therefore shows no switch — so
that grant cannot be revoked from the UI at all, only via the API. That is a
one-way door in the product.

**Context:** Two coherent resolutions. (a) Widen the toggle to any member row
whose `photoLead` is true or who is eligible, matching the endpoint. (b) Keep
the UI engineer-only and have `setPhotoLead` refuse non-engineer targets, making
the seeded manager grant a data mistake to correct. Option (a) matches the
spec's intent ("photo lead = the site supervisor", who is often the manager) and
needs only a condition change plus a test; option (b) needs a service guard and
a seed fix. Nothing has been decided.

**Effort:** S
**Priority:** P3
**Depends on:** Nothing.

## Completed
