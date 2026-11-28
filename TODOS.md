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

## Site video

### The capture gate is on, the project cap is gone, four handset checks are still owed (2026-11-28)

`SITE_VIDEO_CAPTURE` was `true` on every production container while the device gate was
open. It was turned off at the source that morning (Coolify env, generated `.env`, and a
container recreate), and turned back on the same day on the owner's instruction with the
checks still owed. Written down plainly because the sequence is the record: the feature
is live in production, and the four handset-only checks are a debt against it, not a
blocker in front of it.

The known failure those checks cover: a low-end Android misses the 3 second playback bar,
measured at 9.50 s in the emulator.

The per-project cap is gone. `SITE_VIDEO_PROJECT_CAP_BYTES` is unset in production and
`projectCapBytes` is `null` in `readSiteVideoConfig`, which `chargeLedgers` reads as "no
project limit". The per-project ledger row is still written and still credited on delete,
so spend per villa stays visible; nothing refuses a charge against it any more. The org
cap (8 GiB) is unchanged and is still the wall, still enforced by the conditional UPDATE
inside the insert transaction. The trade-off accepted: one project can now fill the whole
org quota. Reopen the per-project cap if a multi-project org starts starving one project
to feed another.

To turn the feature off again: set `SITE_VIDEO_CAPTURE=false` in Coolify's env and
recreate the containers (a push, or `docker compose -p 0bjahklz8gtdtr4do4r7ae6m up -d`
in `/data/coolify/services/0bjahklz8gtdtr4do4r7ae6m` once the generated `.env` carries
the value). Boot refuses to start with the flag on and no org cap, by design.

## Access control

### RLS is FORCEd on every table now, and the owner still bypasses it

Seven tables had RLS enabled and FORCE off: Feedback, LeadFact, OutboundMessage,
ProgressPhoto, ProjectOption, ProjectStaffRole, WhatsappUnknownContact. The header
of `src/rls.ts` claimed otherwise, and so did a hand-written list in
`policies.sql`, which is exactly how the gap survived. FORCEd on 2026-11-28
(migration `20261128091000_force_rls_remaining`), and `policies.sql` now derives
the list from `pg_class` instead of naming tables. `packages/database/test/rls-force.test.ts`
fails if any table is ever enabled and not forced again.

**That does not close the hole it looks like it closes.** `shadhil`, the table
owner, is SUPERUSER with BYPASSRLS on dev and prod, and a superuser ignores FORCE.
Any connection as that role reads every table unfiltered, forced or not - all 34,
not just the seven. The runtime never connects as it: both apps use the pooled
`shadhil_app`, which owns nothing and is not superuser. The owner is reached by
migrations, the seed, the tests, and psql through the SSH tunnel, so the exposure is
whoever holds `DIRECT_DATABASE_URL`.

**The obvious fix is not available.** `ALTER ROLE shadhil NOSUPERUSER` is refused:
`shadhil` is the cluster's bootstrap role (OID 10, `POSTGRES_USER` at initdb) and
Postgres answers "The bootstrap user must have the SUPERUSER attribute". Tried on
dev 2026-11-28; prod runs the same image with the same bootstrap user, so it will
answer the same.

**The workable equivalent, verified on dev with a stand-in role:** a non-superuser
role that OWNS the tables, with `shadhil` kept only as the bootstrap superuser
nobody connects as. With FORCE in place such an owner reads 0 rows with no GUCs and
4 rows under ADMIN GUCs on the same table, which is exactly the behaviour the
policy is supposed to have. What it costs:

- `REASSIGN OWNED BY shadhil TO <owner>` across every object, and the database
  itself.
- `GRANT USAGE ON SCHEMA public TO <owner>`: PG16 does not hand that out to a new
  role, and without it the owner cannot even see the tables ("permission denied for
  schema public", which reads like a missing table if you are not expecting it).
- Migrations must run as the new owner, so `DIRECT_DATABASE_URL` and the shadow
  database follow it. The app role's grants survive, because grants belong to the
  object, not to the owner.
- **The seed breaks.** It bypasses with `SET LOCAL row_security = off`, and a
  non-superuser owner is refused: "query would be affected by row-level security
  policy for table Feedback". The seed would need the GUCs per write, or its own
  role granted BYPASSRLS (unconstrained by design, so give it nothing but the
  seed).

Or accept the superuser and treat `DIRECT_DATABASE_URL` as privileged: never in a
BI tool, an ad-hoc script, or a laptop session that is not a migration.

The owner-role work is planned in `docs/planning/OWNER-ROLE-MIGRATION.md`: four
roles, the order to move them in, and the measured trap that decides the design
(a SECURITY DEFINER helper owned by a non-bypass role silently starts answering with
the caller's own visibility, which is exactly what `project_unit_ids` exists to
avoid).

### Database credentials: rotated in production, and one earlier claim corrected (2026-11-28)

Done. `shadhil_app` has its own secret, 24 characters, living only in Coolify's env,
Coolify's generated `.env`, and the host PgBouncer userlist. The database role, the
pooler and the running containers were all changed in one sequence and verified over
the network: the new password is accepted, the old one is refused both by the pooler
and by Postgres directly, and eight live app sessions prove the API reconnected.

Two corrections to what was written here earlier, because being wrong in a TODO is
worse than being slow:

1. The two roles did **not** share a live password. The repository's
   `docker/coolify-compose.yml` had the same 14-character literal in both the app URL
   and the owner URL, but that owner URL was stale: production's owner credential is
   the 32-character `PG_PASSWORD` from Coolify, and the 14-character value only ever
   authenticated as `shadhil_app`. The finding was "the app's password is committed in
   plaintext and reused in a credential the owner URL also claimed", not "one secret
   opens both roles".
2. `pg_hba` inside the production Postgres trusts `local`, `127.0.0.1` and `::1`, so
   every `docker exec ... psql` check silently ignored the password. Any test of a
   credential has to come over TCP from another container. The first round of checks
   here proved nothing and had to be redone.

Both compose files now interpolate every credential (`${SHADHIL_APP_PASSWORD}`,
`${PG_PASSWORD}`), so no database password is in the repository. Git history still
carries the old 14-character value, which is now worthless.

### Tenant identity is forgeable by any credential that can run SQL (measured 2026-11-28)

Every RLS policy keys off session GUCs (`app.user_org_id`, `app.user_role`,
`app.user_id`). Zero policies reference `current_user`. Postgres cannot tell an
honest application from a hostile one: whoever holds the credential sets the GUCs.

Measured on dev, connected as `shadhil_app`, which is the non-superuser,
RLS-enforced role the API uses:

| Caller                                  | Leads visible |
| --------------------------------------- | ------------- |
| `shadhil_app`, no GUCs                  | 0             |
| `shadhil_app`, GUCs forged for Builders | 31            |
| `shadhil_app`, GUCs forged for Test     | 158           |
| `shadhil_app`, GUCs forged for Demo     | 66            |

So RLS stops accidental cross-tenant queries and a bad JOIN. It does not stop a
leaked `DATABASE_URL`, and it never did. The owner-role migration removes
cluster-level superuser exposure, which is worth doing, but it does not change this.

Making the tenant unforgeable needs one of: a per-tenant database login, a signed
tenant token verified inside a SECURITY DEFINER function, or a database per tenant.
All are larger than anything currently planned. Decide which before spending more
time on role taxonomy, and keep the forged-GUC test from
`docs/planning/OWNER-ROLE-MIGRATION.md` (W19) as the red test that proves the fix.

### A materialised access key for engineer scope: considered, rejected (2026-11-28)

Twenty-style scope tables were considered for engineer visibility and are not
being built. Engineer scope is already a single indexed equality inside the policy
(`Unit.assignedEngineerId`). The measured cost is not that equality: it is the OR
beside `customer_can_read_unit(id)`, and for ProgressPhoto a per-row subplan with
two sequential scans on Team.

There is nothing to recover at today's volume. Prod holds 128 units and 11 progress
photos, so the expensive plan costs microseconds. Reopen when one org passes roughly
10,000 progress photos or 5,000 units, and reopen it with `EXPLAIN ANALYZE` against a
prod-shaped copy - the local database degenerates every plan to a scan and its
timings are meaningless.

The narrow version, if it is ever reopened: stamp `ProgressPhoto.assignedEngineerId`
with a partial index on `(assignedEngineerId, takenAt DESC)`, and make the engineer
arm an equality on it. Not a general access-group system - that adds a recompute
path on every assignment, team and role change to replace a predicate that is
already correct.

## Test health

### ~~Shared-tenant test fixtures: five specs collide under concurrency~~ — FIXED 2026-11-23, re-verified 2026-11-26

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

**Re-verified 2026-11-26** on the tree that carries Round 67: three concurrent copies again,
3/3 green, 33 tests each. The suite has grown, so the count differs from 30; the claim has not.

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

## UI / control sizing

### 44px touch targets: the sweep, and what is deliberately still 44px (2026-11-28)

The rule the repo already encodes is "bigger target for coarse pointers", not "36px
everywhere". `pointer-fine:` is a built-in Tailwind v4 variant, and the build emits
`@media (pointer:fine)`, so the pattern is: keep the coarse size as the base class and
override it for a fine pointer. Width queries are wrong for this and always were (a
landscape phone is 568-844px wide and still a finger device), which is why
`sm:size-11` in `app-header.tsx` became `size-11 pointer-fine:size-9`.

Measured this round, `grep -rlE '(size-11|h-11|min-h-11|sm:size-11)' apps/web/src`
excluding tests: 38 files, 4 already gated, 34 ungated.

Changed, all additive overrides on the element itself:

    components/theme-toggle.tsx              default button 44 -> 36 on fine
    components/app-header.tsx                theme toggle, both popover triggers
    components/offline-queue-badge.tsx       icon button
    components/inventory/ProgressPhotoActions.tsx   photo actions button
    components/teams/project-team-list.tsx   row actions button
    components/shared/ModulePending.tsx      BackLink
    components/site/SiteVideoPlayer.tsx      download link
    components/dashboard/dashboard-shared.tsx  section "more" link

Deliberately left at 44px, with the reason each time:

- **The portal** (`portal-nav`, `portal-lock`, `portal-header`, `portal-sign-out`,
  `portal-push-prompt`, `unit-switcher`, `photo-lightbox`). Thumb-driven on a phone by
  design. A phone in a hand is the surface, and 44px there is load-bearing, not stale.
- **Site capture and viewing** (`SiteRecorder`, `SiteCaptureView`, `SitePhotoViewer`,
  `ZoomableImage`). An engineer films and reviews on a handset at the site. The recorder
  buttons stay 44px on every pointer type because the same person sometimes reviews on a
  laptop and the layout is already built around these sizes.
- **Form inputs** on the guest and settings surfaces (`min-h-11 w-full`). That is the
  design system's input height, not a tap target to shrink: 44px is a normal desktop
  input, and the dense 36px call came from admin tables specifically.
- **Skeletons and spacers** (`[&>div]:h-11` on a Skeleton, `<span className="size-11"
aria-hidden>`). Not controls.
- **Grid cells** (`year-view-day-cell.tsx`, dashboard cards built as links). The cell IS
  the target and the grid's geometry depends on its size.
- **`PageError` and dialog close buttons.** Both are descendant selectors
  (`[&_button]:min-h-11`, `[&>[data-slot=dialog-close]]:size-11`). Stacking an arbitrary
  variant onto `pointer-fine:` was not proven to compile, and a wrong guess compiles to
  nothing rather than failing, so they were left alone rather than half-done. If someone
  wants them changed, prove the stack in the built CSS first.

The next file that matches the grep gets the same three-way question: real touch target
and gets gated, dense pointer-only surface and goes to 36px, or not a control and gets
left alone.

## Completed

### A system action now leaves a row on the lead timeline - DONE 2026-11-28

The confirmation used to write a `SiteVisit.confirmedAt` stamp, an audit row and
notifications, and nothing on the lead timeline - so a telecaller scrolling the
lead saw the customer's "YES" message and then no record of what it did.

`Activity.userId` is nullable now, and a NULL means what it says: the system wrote
this row and no staff member did. Attribution was the whole decision: naming the
visit's assignee would have put a false actor on the page a telecaller reads to
find out who did what, and the read path already coped with no name -
`leads.service` maps `userName: a.user?.name ?? null` and the timeline hides the
"by ..." line when it is null. So the honest option turned out to be the smaller
one.

Two RLS arms were needed, not one: `activity_insert_cron_service` to admit the
write, and `activity_select_cron_service` because RETURNING is checked against
SELECT - the same trap as AuditLog (migration `20261128074500`), which is worth
remembering: **a cron-context INSERT that asks for its row back needs a SELECT
arm too.** Migrations `20261128081500_activity_system_actor` and
`20261128082000_activity_cron_service_read`.

Both arms write through `recordSystemActivity` in `leads/lead-activity.ts`. The
confirm row is written inside the same transaction as the stamp and the audit row,
so the three cannot come apart; the reschedule row is best-effort, because a
timeline write must never stop the team being told.

### users.service.ts split into its six concerns - DONE 2026-11-26 (Round 67)

2,658 lines in one class, against an 800-line ceiling, and the reporting-line rule had to be
re-checked by hand because three points in that file could disagree about it.

It is now a 186-line facade plus one file per question a caller has:

    users.login-lookup.ts        resolveLoginIdentifier        (public path, no JWT)
    users.writes.ts              create, changeRole, update, remove
    users.profile.ts             updateSelf, changePassword
    users.manager.ts             assignManager
    users.directory.detail.ts    getUser
    users.directory.list.ts      list
    users.directory.scoped.ts    projectSalesExecs, teamMembers
    users.support.ts             types, the P2002 mapping, and UsersBase

`UsersBase` supplies `client`, `logger`, `storage` and the four shared lookups, which is what made
the move mechanical: all 19 method bodies are byte-identical to the lines they replaced (checked by
string comparison against the pre-split file), so the split cannot have changed behaviour. The
concerns are constructed inside the facade rather than injected, so the Nest module, the
controller and every `new UsersService(prisma)` in the unit tests are untouched.

**The constraint this entry existed for still applies to future edits:** `assignManager` carries
scoped-delete, post-condition assertion and single-transaction audit semantics with long comments
explaining past bugs. Those comments moved verbatim; do not paraphrase them.

**Verified:** backend type-check and lint clean, 197 tests across `src/users/`, plus the five
DB-backed users specs (143 tests) and the full backend suite. No behaviour change was attempted or
made.

### A skipped site-update delivery can be sent again - DONE 2026-11-26 (Round 66)

`POST /api/customer-progress/site-updates/:deliveryId/resend` retries the SAME delivery row through
`enqueue()`, so every gate re-runs: the kill switch, the buyer, the template, the consent. A refusal
is a 200 with the server's own sentence (`resendMessage`), not an error, because "the buyer has not
opted in" is a fact about the buyer rather than a fault. The staff row gains a "Send again" control
only for outcomes that did not reach the buyer; SENT/DELIVERED/READ are refused in the service, not
in the UI, because a second send is a duplicate message to a real person. The message input is
re-derived from the batch's newest row and the unit, so a client cannot restate a caption or a villa
number into a buyer message.

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
