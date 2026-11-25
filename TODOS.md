# TODOS

Deferred work captured by plan reviews. Organised by component; items sorted
P0 first. Format reference: `~/.cursor/skills/gstack/review/TODOS-format.md`.

## Users / Teams

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

### Shared-tenant test fixtures: five specs collide under concurrency

**What:** DB-backed specs seed into the SAME demo organization. Rows that are per-ORG therefore
belong to every suite at once, and vitest runs files in parallel against one database. Three
concurrent full suites produced 8, 11 and 6 failures, in five specs, all of one shape:

    site-video-ledger.db.test.ts        "expected {org: 36700160} to equal {org: 26214400}"
    overdue-alerts.processor.test.ts    "expected 3 to be 1" (org-wide reminder scan)
    visit-reminders.test.ts             mutates the ORG row (visitReminderLeadMinutes)
    visits.notifications.test.ts        shared pending-row reads
    outbound.cron.test.ts               shared outbox rows

**Why it matters:** a red suite that goes green on a re-run trains everyone to re-run. It hides
real failures, and it costs minutes every time it fires.

**Fix, and why the ORGANIZATION is the unit of isolation:** RLS is scoped to `app.user_org_id`, so
a private org per suite makes another file's rows invisible at the POLICY layer. Nothing
test-only leaks into a business path, and the tenant boundary is the one production uses. A
private PROJECT inside the demo org would NOT fix it: `StorageUsage` is one row per organization,
the overdue scan is org-wide, and `visitReminderLeadMinutes` is org configuration.

`apps/backend/src/test-utils/test-tenant.ts` provides `createTestTenant(label)`: a fresh
organization (id + slug unique per run) through the owner-role test client, and `dispose()` which
deletes the org and lets the cascades take users, projects, leads, ledgers and notifications.

**Converted and verified (2026-11-23):** all five that collided. Each runs green alone, in the
full suite (121 files / 2176 tests), and three copies of all five run CONCURRENTLY: 3/3 green,
30 tests each. The same configuration failed 8, 11 and 6 tests before.

    site-video-ledger.db.test.ts
    overdue-alerts.processor.test.ts
    visit-reminders.test.ts
    visits.notifications.test.ts
    outbound.cron.test.ts

**Four constraints, each learned by breaking it first:**

1. **A tenant isolates rows, not work.** `tick()` scans and CLAIMS every organization, so a
   parallel suite processes this tenant's rows: it stamps the visit, it sends the outbound row.
   `holdCronLockForFile(tenant)` takes the advisory lock for the WHOLE file (before seeding, after
   teardown), which is the property the production Redis lease gives. A lock around a single tick is
   not enough: the other file's tick still eats what this one seeded in between.
2. **Do not assert a tick's return value** (`considered > 0`, `sent >= 1`, `claimed === 1`). The
   other process may legitimately have done the work. Assert the outcome: who received what, and
   the durable stamp that dedupes the next tick.
3. **Teardown is not one DELETE.** `Organization` is FORCE-RLS and seven children are ON DELETE
   RESTRICT (User, Team, Lead, Booking, AuditLog, LeadFact, WhatsappUnknownContact). `deleteMany`
   on the org deletes nothing and reports success - it leaked 73 orgs into the test database before
   this was found, and their PENDING outbound rows are what the next tick claims. `purgeOrganization`
   deletes those seven in dependency order, then the org; `dispose()` throws rather than leaking.
   `sweepStaleTestOrgs` reaps orgs from killed runs at file lock time, `test-*` slugs only, older
   than five minutes so a live parallel file is never taken. Residual hole, accepted: a run that
   dies inside that window leaves PENDING rows the next cron file's tick will claim. Closing it
   needs a liveness marker on the org row - purging every other test org at lock time would delete
   rows under the non-cron specs that write outbound rows (webhooks.controller, site-update-delivery).
4. **Process-wide env cannot be isolated by a tenant** (`WHATSAPP_PHONE_NUMBER_ID`,
   `LEADS_FALLBACK_OWNER_ID`, the `SITE_VIDEO_*` caps). Those specs need the value injected per test
   or per worker. Also: once test orgs exist, every org-wide scan sees them, so a spec asserting a
   global total has to scope to its own org id.

Side benefit: `outbound.cron.test.ts` now seeds a phase + unit in its own org, so the two
site-update delivery cases actually RUN instead of quietly returning early when the database had no
unit to hang a delivery on.

**Remaining:** the other ~56 DB-backed specs still share the demo org. They pass because they only
touch their own project-scoped rows. Convert any that start counting org-wide rows, or that drive a
cron, with `createTestTenant` + `holdCronLockForFile`.

## Completed

### Customer-facing phone display in the portal - DONE 2026-11-26 (Round 65)

Built exactly as this entry prescribed: `customer_self_phone()` (SECURITY DEFINER, in
`policies.sql` beside `customer_lead_id()`), a `PortalMeDto.phone` field and the hero line, plus
tests that the helper cannot widen another role's read. It reuses `customer_lead_id()` rather than
restating "which lead is this buyer", and adds the one condition that helper cannot carry: nothing
constrains `User.customerLeadId` to point inside the user's own tenant, so the lead's org is checked
here. Seven DB cases (no context, staff with a pointer, foreign pointer, unlinked, soft-deleted,
wrong org, the happy path) and the portal hero's four.

### A Consent row's organisation must be its lead's - DONE 2026-11-26 (Round 64)

`consent_insert_owner` had gained the lead-org predicate in a later round and `consent_insert_admin`
had not, so the TODO was stale on one half and right on the other. Migration
`20261126033000_consent_org_matches_lead` recreates `consent_insert_admin` with the predicate, adds
a `consent_org_matches_lead` BEFORE INSERT/UPDATE trigger so the invariant holds for the owner role
and every future writer, and relinks (never deletes) any existing mismatched row. Measured before
writing it: 144 dev rows, 0 mismatched, so the repair is a no-op here. Pinned by six new cases in
`packages/database/test/consent-rls.test.ts`.

### Org-scope the five `User` target reads - DONE 2026-11-25 (Round 61)

**What shipped:** `changeRole()`, `assignManager()`, `remove()`, `getUser()` and
`changePassword()` all read the target user with `organizationId: actor.organizationId`.
The backlog listed two sites; the class had five.

**Why the count was wrong:** `User` carries no RLS, so every read of a user by id in the
service layer is a hand-written tenant check, and the last audit found three of them. The
two it missed were the read path and the password reset, and the reset is account takeover
across tenants rather than a leak: the admin-reset branch needs only that the actor outrank
the target, and an ADMIN outranks a TELECALLER in every org.

**Proof:** five DB-backed cross-org cases in `users.service.rls.test.ts`. All five fail
against the pre-fix service (reverted and re-run) and pass after it, with the rows asserted
untouched.

**Effort:** S, as estimated. The work was the audit, not the edit.
