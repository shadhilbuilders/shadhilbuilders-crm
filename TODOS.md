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

### ~~The photo-lead grant has no route to use it~~ — FIXED 2026-11-07

**Shipped:** `PATCH /api/customer-progress/photos/:photoId` (caption only) and
`DELETE /api/customer-progress/photos/:photoId` (row, then bytes). UI is inline on each
staff timeline row (`ProgressPhotoActions.tsx`), with a confirm dialog whose copy names
the customer portal because a buyer may already have seen the photo.

**Authority is RLS's, not the service's.** Both methods read the row inside the
caller's `withRlsContext`; if `progress_photo_update` / `progress_photo_delete` deny it,
the read returns nothing and the answer is 404 - never 403, which would confirm the row
exists. That keeps one statement of the rule and makes drift impossible.

**Two deliberate choices:**
- Caption is the ONLY editable field. `phaseId` is a property of the unit (the upload
  stops asking), `takenAt` is evidence of when site work happened, `unitId` would move
  a buyer's photo to another home. zod strips the others, so the DTO cannot carry them.
- Delete is ordered row-then-bytes, with the audit row written INSIDE the transaction
  (before the bytes go). A blob failure logs a WARN and returns success: the record
  survives and an operator still has the key to find the orphan. The reverse would
  leave a row pointing at bytes that are gone.

**Tests:** 14 service cases + 8 UI cases + 1 DB case proving the DELETE arm (creator,
photo lead, ADMIN allowed; a non-owner's `deleteMany` removes 0). The UI controls are
driven by a server-computed `canMutate` flag rather than a client-side role guess.

**Still open (not this item):** bulk correction, undo, and a "replace photo" flow.
None is specified; none was in scope.

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

### ~~Media bytes are org-scoped, not row-scoped~~ — FIXED 2026-11-07

**What:** `GET /api/media/:key` now enforces two walls:
1. the key's first path segment must be the caller's org
   (`media-key-scope.ts`, 12 tests);
2. an owning row must be visible to the caller under their own RLS context
   (`media-access.service.ts`, 11 tests).

The second is the one that closes intra-org exposure. The key is resolved against
`ProgressPhoto.key` or `Message.mediaKey` (plus the legacy `Message.mediaUrl` BFF-path
form, so attachments older than 2026-09-18 still resolve) inside the caller's
`withRlsContext`, so the policies - not a second copy of the rules - decide what is
visible. A key with no visible owner answers 404, exactly like a key that does not
exist; a 403 would confirm it is real.

**Residual, accepted:** a staff member in the right org can read any key whose row
they can already see - which is the intent. The cost is one extra indexed lookup per
media read (ProgressPhoto has an index on the row; Message.mediaKey is unindexed, so a
chat attachment read does a scan). If that shows up in a trace, add
`@@index([mediaKey])` to `Message`.

**Rejected designs:** (a) sign short-lived URLs - needs a signing secret and a new
URL surface, and the BFF already carries the session; (b) a `MediaObject` table - a
migration plus a backfill for a problem two indexed lookups solve.

## Completed
