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

**Scope decision 2026-11-07:** deliberately NOT built in the slice-1/2 completion pass.
Slice 1 assigns photo correction to slice 4, and the consuming routes are a product
surface (what happens to a photo a buyer has already seen?) rather than a loose end.
The grant, the RLS arms and the now-correct toggle all ship; only the routes are
deferred. Treat this as slice 4's first task.

### The photo-lead toggle only renders on ENGINEER rows — RESOLVED 2026-11-07

**Decision:** Option (a) — widen the toggle. The switch now renders on every member
row in `MemberRoster` whenever `canManage` is true, matching what `setPhotoLead` and
the RLS policy already accepted. `canManage` stays OWNER/ADMIN-only, and the endpoint
re-checks `isAdminClass` server-side, so this widens the UI to the endpoint's existing
authority rather than widening the authority itself.

**Why this option:** The spec's intent is "photo lead = the site supervisor", who is
commonly the manager, not an engineer. The seeded demo data already grants PHOTO_LEAD
to a MANAGER on Metro Heights. Option (b) would have required a service guard + a seed
correction to make valid production data an error.

**Tests:** `project-team-list.test.tsx` — 4 cases pin that a MANAGER row shows the
switch, that the checked state reflects the server (`aria-checked="true"`), that every
non-manager row carries it regardless of role, and that `canManage=false` renders none.

**Historical note:** the previous text here said `project-team-list.tsx:237` gated the
switch on `m.role === 'ENGINEER'`, which meant a MANAGER's seeded grant could not be
revoked from the UI at all — a one-way door.

## Security

### Media bytes are org-scoped, not row-scoped — PARTIALLY FIXED 2026-11-07

**What:** `GET /api/media/:key` now refuses any key whose first path segment is not
the caller's org (`apps/backend/src/storage/media-key-scope.ts`, 12 tests). That closes
the cross-tenant read. What remains open is intra-org: any authenticated session in the
right org can read any key it holds, even one belonging to a photo/attachment row that
RLS would hide from them.

**Why it matters:** A progress photo is protected by `progress_photo_select_*` at the
row level, but `mediaUrl` points at the bytes. A CUSTOMER in the correct org who
obtained another buyer's key would read that image. Keys are `{org}/{cuid}/{name}`, so
this needs a leak rather than a guess — that is why it is P2 rather than a hotfix.

**Why not fixed now:** Proper row-level authorization needs a key→row lookup (which
table owns this key?) plus an actor check, i.e. a per-request join on a hot media path.
That is a design decision, not a patch. Options: (a) sign short-lived URLs at read time,
(b) add a `MediaObject` table keyed by storage key carrying its owner scope, (c) resolve
the key against the four owning tables (ProgressPhoto, Message, OutboundMessage,
attachment) in order. None has been decided.

**Context:** The original defect was worse — no org check at all, so any authenticated
user in ANY org could read a key they held. That is the fixed half. Start at
`media.controller.ts` `read()`.

**Effort:** M
**Priority:** P2
**Depends on:** A decision on which of (a)/(b)/(c) to take.

## Completed
