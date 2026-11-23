# TODOS

Deferred work captured by plan reviews. Organised by component; items sorted
P0 first. Format reference: `~/.cursor/skills/gstack/review/TODOS-format.md`.

## Users / Teams

### Customer-facing phone display in the portal (blocked on RLS)

**What:** Show a buyer their own mobile number in `/portal`, sourced from their
`Lead`.

**Why it is not free:** `Lead` has no CUSTOMER SELECT policy (`policies.sql` — only
`lead_select_telecaller`, `_manager`, `_admin`, `_mentioned`, `_cron_service`), and
FORCE RLS is on. A CUSTOMER's own `tx.lead.findFirst()` returns **zero rows
silently**, not an error. `customer-portal.service.ts` therefore never reads `Lead`
today — it reaches units only through `booking_select_customer`.

**What it needs:** a `SECURITY DEFINER` helper (same shape as
`customer_lead_id()`, `policies.sql:2036`), a `PortalMeDto` field, and a test that
the helper cannot widen another role's read. Roughly a day, and it should not ride
along with the `User.phone` change.

**Context:** `docs/designs/2026-11-18-user-phone.md` D3 cut this deliberately. The
portal has never displayed a phone — only `Organization.contactPhone` in
`PortalLock` — so this is a new capability, not a regression.

**Priority:** P3
**Depends on:** the `User.phone` slice landing first.

### Org-scope the `changeRole()` and `assignManager()` target reads

**What:** Both read the target user with `findUnique({ where: { id } })` and no
`organizationId` filter (`users.service.ts:456`, `:963`), gated only on the role
hierarchy. `User` carries no RLS, so an ADMIN in org A can currently act on a user
in org B if they know the id.

**Why it matters more now:** the `User.phone` slice fixes `update()` (third site)
and adds a **per-org** unique phone index. The same missing filter on the other two
paths is the same bug class, and it is worse on a column with a tenant-scoped
constraint.

**Context:** found during the 2026-11-18 review of
`docs/designs/2026-11-18-user-phone.md`; deliberately not bundled there to keep
that diff to one behavioural change per site. `update()` gets the filter in this
slice.

**Effort:** S
**Priority:** P2
**Depends on:** None — but land it separately, with a cross-org test in
`users.service.rls.test.ts`.

### ~~Multi-team ENGINEER shows the manager of their newest team~~ — RESOLVED 2026-11-07

**Decision (product):** report EVERY team and its manager.

`reportsTo` is now `{ teamId, teamName, manager }[]` on both the admin Users rows and
the user detail; the UI renders one line per team and adds the team qualifier when
there is more than one. An engineer on Team A (Ramesh) and Team B (Suresh) now shows
both, instead of only whichever team happened to be newest.

**Why:** their RLS access covers every team they belong to, so naming one manager
described an access model the product does not have. Which single name appeared also
silently flipped from oldest to newest when D8 landed, so the surface was unstable as
well as lossy.

**Compatibility:** the old single-value field survives one release as
`reportsToPrimary` (list) and `manager` (detail), both now DERIVED from the list rather
than queried separately - which also fixed a doubled `findOrgOwner` round trip on every
MANAGER/ADMIN detail view.

**Batching:** the list path reads memberships with ONE query per page (filtered to the
row ids), so paging 50 users still costs the same round trips as before. Soft-deleted
teams are excluded (they grant no access, so they are not a line to advertise).

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

**Decision 2026-11-07:** deferred. The duplication that motivated this entry is already
gone — the exhaustive `reportingTargetFor` map replaced the three copy-pasted role
unions, and `resolveReportingLines` is now the single resolver behind both read paths.
What remains is structural size (~1,900 lines), not a correctness hazard, so it is not
worth making a five-file breaking-change diff unreviewable by bundling it.

### ~~Team resolution order diverges between "display" and "lead creation default"~~ — RESOLVED 2026-11-07

**Decision (product):** NEWEST wins in both places.

`leads.service.create` now orders memberships `assignedAt desc, teamId asc`, matching
`resolveDisplayTeamId` and the three other display resolvers. The comment at the call
site explains the ordering rule rather than leaving it implied.

**Why:** a telecaller on two teams saw Team B on their profile while their new leads
landed in Team A. Nothing marked either team "primary", so "oldest" was an accident of
insertion order, not a decision.

**Blast radius:** routing and reporting only - the actor owns the lead either way, so no
access changes. The `teamId` tie-break is load-bearing: `assignedAt` defaults to `now()`,
evaluated once per transaction, so a bulk membership insert can share a timestamp.

## Customer progress (photos)

### A skipped site-update delivery cannot be re-sent

**What:** Every non-sent outcome is recorded on `SiteUpdateDelivery`
(`SKIPPED_DISABLED`, `SKIPPED_NO_BUYER`, `SKIPPED_NO_TEMPLATE`, `SKIPPED_NO_CONSENT`,
`SKIPPED_WINDOW`, and a final `FAILED`), and none of them can be acted on. The row is a
record, not a queue: nothing retries, and no operator action exists.

**Why it matters:** `SKIPPED_NO_CONSENT` is about to be the normal answer for every
buyer until the opt-in capture paths exist, and `SKIPPED_DISABLED` exists so a bad day
can be switched off without losing updates. Both are only worth having if the skipped
batches can go out later. Today the engineer sees "Not sent: buyer has not opted in",
records the opt-in on the lead page, and the update is gone.

**The two cases are not equally hard, and should not be one feature:**

1. A final `FAILED` has a live `OutboundMessage` row. Re-sending is a reset:
   `status = PENDING, attempts = 0, claimedAt = null, lastAttemptAt = null`. Cheap, and
   it reuses the whole existing retry path. Needs a guarded endpoint (staff, org-scoped)
   and a button on the staff row.
2. A `SKIPPED_*` row has NO outbox row at all: the skip happens before `message.create`.
   Re-sending has to rebuild the message, which means rebuilding the inputs - the media
   row, the note, `hasNote`, the villa label. None of that is on the delivery row today;
   only `batchId`, `unitId` and `organizationId` are. For a photo batch the batch id is
   `photo-<ISO takenAt>`, which is recoverable, but relying on parsing an id string to
   find the media is exactly the kind of thing that breaks silently. The honest fix is
   to store `rowId` and the caption inputs on the delivery row at write time, then have
   a re-send call `recordAndSend` again with the same batch id (the unique
   `(organizationId, batchId)` would refuse, so it needs to update the existing row
   rather than insert).

**Context:** found 2026-11-23 while fixing the PENDING-never-advances defect
(`b5b798d`). The switch commit (`4b2ca69`) and the plan handoff both claimed the row
"keeps the batch visible for a re-send"; the row is visible, the re-send does not
exist. The handoff now says so.

**Effort:** S for the `FAILED` reset, M for the `SKIPPED_*` rebuild (one migration to
carry the media reference and caption inputs).
**Priority:** P3 (nothing is being sent to buyers yet: no approved consent rows and a
test sender), rising to P2 the day the templates go live.
**Depends on:** Nothing, but land the `FAILED` reset first; it proves the endpoint and
the UI affordance before the harder half.

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

### A Consent row's organisation is not required to be its lead's

**What:** Both `Consent` INSERT policies check the row against the ACTOR's org
(`"Consent"."organizationId" = current_setting('app.user_org_id', true)`) but nothing
checks it against the LEAD's org. Add the lead-org predicate to
`consent_insert_owner` and `consent_insert_admin`:

```sql
AND EXISTS (
  SELECT 1 FROM "Lead" l2
  WHERE l2.id = "Consent"."leadId"
    AND l2."organizationId" = "Consent"."organizationId"
)
```

**Why:** An ADMIN in org B can insert a consent row stamped org B that points at a
lead in org A. The FKs are per column (`leadId -> Lead.id`, `organizationId ->
Organization.id`), so no constraint holds the pair together. Today the damage is
clutter inside the writer's own tenant: `consent_select_*` filters on the row's org,
so org A never sees the row, and the site-update send decision reads the ledger under
org A's context. It stops being harmless the first time anything joins `Consent` to
`Lead` without an org predicate, or exports a ledger per organisation and finds a row
that cites somebody else's lead.

**Context:** found 2026-11-23 while adding the first writer of this table
(`POST /api/leads/:id/consent`, commit `58208df`). The residual is pinned in
`packages/database/test/consent-rls.test.ts`, in the case "refuses a manager from
another team, and an admin from another org", whose comment names it rather than
letting the suite imply the table is fully bounded. Checked before writing this:
144 dev rows, 0 with `Consent.organizationId <> Lead.organizationId`, so no backfill.
The fix is a migration recreating the two policies plus the same edit in
`policies.sql` (policies.sql is the source of truth; the migration carries the delta).
A composite FK on `(organizationId, leadId)` was considered and is heavier: it needs a
`UNIQUE (organizationId, id)` index on `Lead` that does not exist today.

**Effort:** S
**Priority:** P3
**Depends on:** None.

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

## Test health

### `auto-assign.service.test.ts` flakes on the shared test database

**What:** `autoAssignLeads = false → manager owns the lead (pending) > routes to the creating
team manager with ownerType MANAGER` failed once in a full backend run (one file, one test,
2175/2176 green), then passed alone (25/25) and in the next full run (2176/2176). Nothing in
that run touched leads, teams or assignment.

**Why it matters:** this suite runs against a shared database and other specs seed the same
fixture org, teams and managers. A single flaky spec costs a full re-run to tell apart from a
real failure, and the cheap habit it teaches is to re-run until green, which is how a real
regression gets waved through.

**Evidence:** the failing run's assertion text was not captured. Recorded facts: the test name
above, `apps/backend/src/leads/auto-assign.service.test.ts:435`, `1 failed | 2175 passed`.

**Likely mechanism, unconfirmed.** Two candidates, both visible in the file:

1. The test sets `TEAM_B.autoAssignLeads = false` and never restores it. Anything that creates a
   lead in TEAM_B afterwards in the same run sees manager-owns instead of auto-assign. That is a
   within-file ordering dependency, so it should be deterministic - unless a second vitest process
   shares the database, which is exactly what happened while the web suite was running.
2. `phone: '+9199' + ((Date.now() + 300) % 1e8)` is a millisecond-derived number, and the clean-up
   in `afterAll` does not run if a run is killed. A leftover row with the same phone can make
   `service.create` return a pre-existing lead, whose `ownerId` is whatever assigned it the first
   time.

**Fix:** restore `autoAssignLeads` in `afterEach`; build the phone from `RUN_TAG` (already defined
in the file) instead of a millisecond offset so a leftover row cannot collide; and on the next
occurrence capture the assertion text rather than only the summary line.

**Effort:** S.
**Priority:** P2. It hides real failures and it already cost one full re-run. The durable version
of this is per-file isolation (own org, or a transaction that rolls back), which is a bigger job
worth doing once rather than per spec.

## Completed
