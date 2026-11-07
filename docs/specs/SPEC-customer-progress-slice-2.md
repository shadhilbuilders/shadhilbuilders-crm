# SPEC: Customer Progress Portal, slice 2 - portal shell, customer auth, live timeline

Status: draft for approval. Design source: `docs/designs/customer-progress-portal.md`
(eng + design reviews CLEARED 2026-10-26). Slice 1 shipped: PR #8, main `198e335`,
closed out in PR #13, main `349b9e4`.

## Context

Buyers of Shadhil Builders still have no way to see construction progress on their
own unit. Slice 1 gave site staff a phone-first upload flow and a staff-only preview
timeline against real photos. Slice 2 opens that same data to the buyer: a CUSTOMER
role, a portal route group outside `[orgSlug]`, the customer-facing timeline scoped to
the customer's own booking by RLS, and web push on each new upload. Slice 3 adds
booking details, payments and documents on the same shell.

The reason this is a spec and not a patch: slice 2 is the first surface in this repo
where a read is authorized by *owning a booking* rather than by team membership. There
is no existing pattern to copy and no customer identity in the database yet, so the
join has to be designed before any code is written.

## Current State

Verified 2026-11-06 on `main` @ `349b9e4`.

| Fact | Evidence |
|---|---|
| No customer identity exists anywhere in the schema | `grep -nE "customerId|customerUserId|buyerId" packages/database/prisma/schema.prisma` returns nothing |
| `Booking` hangs off `Lead`, with no `User` link for the buyer | `Booking.leadId`, `Booking.unitId`, `Booking.userId` (the staff member who created it), `Booking.approvedById` |
| `Lead` has buyer contact fields but no `User` relation | `Lead.name`, `Lead.phone` (`@unique`), `Lead.phoneE164` (`@unique`), `Lead.email String?` |
| `Booking.status` has 5 values, none of which mean "customer may see this" | `enum BookingStatus { HOLD TOKEN APPROVED REJECTED CANCELLED }` |
| Role enum has 6 values, ENGINEER added in slice 1 | `packages/database/prisma/schema.prisma` `enum Role` |
| The closed role set is enforced in 6 places, each of which throws or fails to compile when one is missed | schema enum; `packages/database/src/rls.ts:96-104` `ROLES`; `packages/auth-client/src/jwt.ts:25-31` `ROLES`; `packages/api-types/src/enums.ts:20-26` `RoleSchema` + `:36` `AssignableRoleSchema`; `apps/web/src/lib/session.ts` `ROLE_RANK` + role helpers; `apps/web/src/lib/labels.ts:280-296` |
| Auth is email/password only. No phone, OTP, SMS or magic-link provider exists in the repo | `packages/auth-client/src/auth.ts:52` `emailAndPassword`, `:130` `plugins` = `jwt` + `admin` |
| Sign-in is global by email, not org-scoped | documented on `User.email` in `schema.prisma` |
| `/login` routes to `/`, which resolves the org slug and enters the CRM shell with no role branch | `apps/web/src/app/page.tsx` |
| No portal routes exist | `apps/web/src/app` contains `(guest)`, `[orgSlug]`, `api` only |
| Push plumbing exists and is wired to VAPID, but nothing enqueues on upload | `apps/backend/src/push/push.service.ts:16-30`, `sendToUser:86`, `deliver:115` |
| Push tables are owner-only under RLS | `policies.sql:840-890` `push_subscription_*` / `push_notification_*` |
| ProgressPhoto has 4 staff policies and no customer arm | `policies.sql:1617-1692`; migration `20261026160800_customer_progress_slice1` |
| `Unit`/`Phase`/`Project` engineer policies exist only in the slice-1 migration, not in `policies.sql` | `unit_select_team_member`, `phase_select_team_member`, `project_select_team_member`, `project_team_select_engineer` are created in migration `20261026160800`; `grep 'ON "Unit"' packages/database/prisma/rls/policies.sql` finds only subqueries inside ProgressPhoto policies |
| Display fields for unit identity exist | `Unit.unitNumber`, `Phase.name`, `Project.name` |
| The two role-rank tables disagree on ENGINEER | backend `RANK` (`apps/backend/src/users/roles.ts:18-26`) puts ENGINEER at 1 on a lower-is-more-authority scale, equal to TELECALLER; web `ROLE_RANK` (`apps/web/src/lib/session.ts:183-190`) puts ENGINEER at 0 on a higher-is-more-authority scale, below TELECALLER. So a telecaller sees edit controls for an engineer row that the backend then rejects. |

Three findings worth stating plainly, because they change the shape of this slice:

1. `policies.sql` claims to be canonical (`AGENTS.md` "Database") but does not carry
   the four policies the slice-1 migration created for `Unit`, `Phase`, `Project`
   and `ProjectTeam`. Any slice that copies the delta from this file inherits an
   incomplete picture. Slice 2 mirrors them in as a no-behaviour-change step before
   adding customer arms.
2. The customer's read path crosses `Booking`, `Lead`, `Unit`, `Phase`, `Project` and
   `ProgressPhoto`. Each of those tables has its own RLS. A policy that subqueries a
   protected table re-enters RLS and, on `TeamMember`, already caused a 42P17
   recursion in slice 1. The customer predicate therefore goes into SECURITY DEFINER
   helpers, following `team_member_exists()` (migration
   `20261027160000_engineer_team_select:18`) and `progress_photo_creator_label()`.
3. Push delivery needs to read another user's subscriptions and write another user's
   notification row. Both are denied to every staff role today. That is one narrow,
   named system path, not a widening of staff rights.

## Decisions locked by this spec

These are the calls an implementer would otherwise have to guess. Each one has a
reason, and reversing one changes the migration.

**D1. Customer identity is `User.customerLeadId`, pointing at a `Lead`.** A buyer's
photos hang off a booking, which hangs off a lead. Giving the login a lead pointer
reuses the whole existing chain and needs no new entity. A separate `Customer` table
would duplicate name/phone/email that `Lead` already owns and would need its own
merge rules when two leads are the same buyer.

**D2. Not unique.** A flat bought jointly needs two logins (husband and wife) that see
the same unit. A `@unique` on `customerLeadId` would force a second `Lead` row and
split the photo history across two leads. Many users may point at one lead.

**D3. Logins are provisioned by staff, not self-service.** There is no SMS or email
provider in the repo (`auth.ts:130`), and the design's journey step 1 already says the
invite goes out over WhatsApp after booking. Staff create the CUSTOMER user through
the existing admin users flow with a temporary password; the existing
`mustChangePassword` gate (documented on `User` in `schema.prisma`, enforced by
`JwtAuthGuard`) forces a password change on first login. No new auth plugin, no new
secret, no new vendor.

**D4. Portal access requires an `APPROVED` booking.** `HOLD` and `TOKEN` are
provisional, `REJECTED` and `CANCELLED` must not leak construction photos or progress
to someone who is not (or no longer) buying. `APPROVED` is the one status that means
the sale is confirmed. This lives in one constant and one policy predicate so a future
status cannot silently widen access.

**D5. A customer may read, never write.** No INSERT/UPDATE/DELETE arm exists for
CUSTOMER on any table. Photo correction is slice 4 and belongs to staff.

**D6. The portal lives at `/portal`, outside `[orgSlug]`.** The tenant comes from the
session, not the URL. A customer URL that carried an org slug would invite a
cross-org typo to become a data-access question.

**D7. The portal is CUSTOMER-only.** The design's staff "View as customer" preview
link needs a staff-allowed read path with its own authorization matrix; it is not in
this slice (see Out of Scope).

**D8. Push is best effort and never blocks an upload.** The upload response returns
the moment the photo row commits. A failing push logs a WARN and moves on, the same
posture as the storage-delete compensation in slice 1.

## Proposed Change

```
[staff phone: Progress tab, Add photo]  (slice 1, unchanged)
  |
  v
[customer-progress.service.upload] --commit--> response
  |
  +--> [PortalNotifier] (best effort, after commit)
         |- CRON_SERVICE RLS context
         |- SELECT PushSubscription for the unit's APPROVED-booking CUSTOMER users
         |- INSERT PushNotification
         '- PushService.deliver -> web-push
                             |
                             v
[phone: notification tap] --> /portal?photo=<id> --> full-bleed photo

[customer login] --> /login --> / (role branch) --> /portal
  |
  v
[GET /api/customer-portal/me]         unit switcher data (unitNumber, project, phase)
[GET /api/customer-portal/units/:id/photos?cursor=]  same TimelineResponseDto as staff
  |
  v
[customer-portal.service] -> withRlsContext(role=CUSTOMER) -> RLS customer_* arms
```

### Schema (one migration)

```prisma
enum Role {
  OWNER
  ADMIN
  MANAGER
  SALES_EXEC
  TELECALLER
  ENGINEER
  CUSTOMER
}

model User {
  // ... existing fields
  // Issue #8 slice 2: the Lead a CUSTOMER login belongs to. NULL for every
  // staff role and for a customer whose lead was deleted (SetNull), which is
  // why the portal treats a null pointer as "not provisioned" rather than
  // "no photos".
  customerLeadId String?
  customerLead   Lead?   @relation("CustomerLeadUser", fields: [customerLeadId], references: [id], onDelete: SetNull)

  @@index([customerLeadId])
}

model Lead {
  // ... existing fields
  customerUsers User[] @relation("CustomerLeadUser")
}
```

No unique constraint (D2). `onDelete: SetNull`, not Cascade: deleting a lead must not
delete the person's login row, audit trail or push subscriptions. The pointer clearing
is what removes portal access.

### RLS: two helpers and six policies

Helpers first. Both are `SECURITY DEFINER` with `search_path = public`, `STABLE`,
`REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO shadhil_app`, matching
`team_member_exists()`.

```sql
-- The caller's lead pointer, valid only when the caller is a CUSTOMER in the
-- org they claim. Returns NULL (fail closed) without GUCs, for staff roles, and
-- for a soft-deleted user.
CREATE FUNCTION customer_lead_id() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT u."customerLeadId"
    FROM "User" u
    WHERE u."id" = current_setting('app.user_id', true)
      AND u."organizationId" = current_setting('app.user_org_id', true)
      AND u."role" = 'CUSTOMER'
      AND u."deletedAt" IS NULL
      AND u."customerLeadId" IS NOT NULL
  $$;

-- True when the caller's lead has an APPROVED booking on this unit in this org.
CREATE FUNCTION customer_can_read_unit(p_unit_id TEXT) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1
      FROM "Booking" b
      JOIN "Lead" l ON l."id" = b."leadId"
      WHERE b."unitId" = p_unit_id
        AND b."status" = 'APPROVED'
        AND b."organizationId" = current_setting('app.user_org_id', true)
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND b."leadId" = customer_lead_id()
    )
  $$;
```

Policies. Every one is `FOR SELECT` and every one carries the org predicate, so a bad
`customerLeadId` that points across orgs still returns nothing.

```sql
CREATE POLICY booking_select_customer ON "Booking"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CUSTOMER'
    AND "status" = 'APPROVED'
    AND "leadId" = customer_lead_id()
  );

CREATE POLICY unit_select_customer ON "Unit"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_unit("id")
  );

CREATE POLICY phase_select_customer ON "Phase"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (SELECT 1 FROM "Unit" u
                WHERE u."phaseId" = "Phase"."id"
                  AND customer_can_read_unit(u."id"))
  );

CREATE POLICY project_select_customer ON "Project"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (SELECT 1 FROM "Phase" ph
                JOIN "Unit" u ON u."phaseId" = ph."id"
                WHERE ph."projectId" = "Project"."id"
                  AND customer_can_read_unit(u."id"))
  );

CREATE POLICY progress_photo_select_customer ON "ProgressPhoto"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_unit("unitId")
  );
```

Plus the push system path, scoped to a service identity and nothing else:

```sql
-- PortalNotifier reads the recipients' subscriptions and writes their queue rows.
-- Guarded by role + a fixed service user id, so no staff or customer session can
-- use it.
CREATE POLICY push_subscription_select_portal_service ON "PushSubscription"
  FOR SELECT USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'portal-notifier'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY push_notification_insert_portal_service ON "PushNotification"
  FOR INSERT WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'portal-notifier'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
```

Deny by absence does the rest: CUSTOMER gets `Lead`, `Message`, `Activity`,
`SiteVisit`, `Reminder`, `OutboundMessage` and `AuditLog` reads as an empty set, which
the matrix asserts exactly. `PushSubscription`/`PushNotification` owner policies stay
untouched, so a customer reads only their own subscriptions.

GRANTs: no new table, so no new table grants. `GRANT EXECUTE ON FUNCTION
customer_lead_id(), customer_can_read_unit(TEXT) TO shadhil_app` and
`REVOKE ALL ... FROM PUBLIC`, in the same migration.

Mirror step, separate commit in the same PR: copy the four slice-1 policies
(`unit_select_team_member`, `phase_select_team_member`, `project_select_team_member`,
`project_team_select_engineer`) from migration `20261026160800` into
`packages/database/prisma/rls/policies.sql` verbatim, so the canonical file matches
what is deployed. No behaviour change; the migration already ran.

### Role migration: eight touchpoints, one release

Adding CUSTOMER alone to any one of these either fail-closes every RLS context or
silently lets a customer into the CRM.

| # | File | Change |
|---|---|---|
| 1 | `packages/database/prisma/schema.prisma` | `Role += CUSTOMER`; `User.customerLeadId` + relation; `Lead.customerUsers` |
| 2 | `packages/database/src/rls.ts:96-104` | `ROLES += 'CUSTOMER'` (the list throws on an unknown role, fail closed) |
| 3 | `packages/auth-client/src/jwt.ts:25-31` | `ROLES += 'CUSTOMER'` (JWT verification rejects unlisted roles) |
| 4 | `packages/api-types/src/enums.ts:20-26` | `RoleSchema += 'CUSTOMER'`; `:36` `AssignableRoleSchema` keeps OWNER excluded |
| 5 | `apps/web/src/lib/labels.ts:280-296` | `ROLES += 'CUSTOMER'`, `ROLE_LABELS.CUSTOMER = 'Customer'` |
| 6 | `apps/web/src/lib/session.ts:183-190`, `apps/web/src/lib/nav.ts:331-341` | `ROLE_RANK.CUSTOMER = 0`; CUSTOMER excluded from `isLinkableStaffRole` (`session.ts:86`), from the `AddTeamMembersDialog` role filter and from every nav list (`nav.ts` role-gated sections). Fix `ROLE_RANK.ENGINEER` from 0 to 1 so it ties with TELECALLER like the backend does |
| 7 | `apps/backend/src/users/roles.ts:18-26` | `RANK.CUSTOMER = 1` (tie with TELECALLER, lowest); `assertCanCreateRole`/`assertCanChangeRole`: CUSTOMER is OWNER/ADMIN only, and MANAGER may never change a CUSTOMER |
| 8 | `apps/web/src/proxy.ts`, `apps/web/src/app/page.tsx`, `apps/web/src/app/[orgSlug]/layout.tsx` | `/portal` behind the session gate; `/` branches to `/portal` for CUSTOMER; `[orgSlug]` layout bounces CUSTOMER to `/portal` |

### Backend

New module `apps/backend/src/customer-portal/{customer-portal.module,customer-portal.controller,customer-portal.service}.ts`,
registered in `app.module.ts`. Separate from `customer-progress` because the actor
model differs; it reuses the photo mapping, which moves to
`apps/backend/src/customer-progress/progress-photo.mapper.ts` with no behaviour change
so both timelines emit the identical `TimelineResponseDto`.

Endpoints (`@Controller('customer-portal')`):

- `GET /api/customer-portal/me` → `{ customerName: string, units: [{ unitId, unitNumber, projectName, projectId, currentPhaseName: string | null, photoCount: number }] }`.
  Only units whose booking is `APPROVED`. Sorted by `projectName`, then `unitNumber`
  natural order. Empty array is a valid response: a provisioned customer whose booking
  is still `TOKEN` sees the "we are setting this up" state, not an error.
- `GET /api/customer-portal/units/:unitId/photos?cursor=` → the slice-1
  `TimelineResponseDto` unchanged (`photos[]` + `nextCursor`, `mediaUrl` relative
  `/api/bff/media/<key>`), same 50-row cursor, `ORDER BY takenAt DESC, id DESC`.

Authorization, all in the service, RLS as the second wall:

- actor role must be `CUSTOMER`, else `403` ("this route is for customer accounts").
- a unit not in the caller's APPROVED bookings returns `404`, not `403`: a 403 would
  confirm that some other unit exists.
- `customerLeadId` null → `403` with the "not linked yet, contact the office" message
  the portal renders as a lock screen.
- every read inside `withRlsContext(this.client, rlsContextFrom(actor), ...)`. The bare
  `prisma` client stays out of this module except in `PortalNotifier` (service
  identity, `AGENTS.md` system-path exemption).

`PortalNotifier` (`apps/backend/src/customer-portal/portal-notifier.service.ts`):

- `notifyNewPhoto({ organizationId, unitId, photoId, caption, phaseName })`.
- Runs with an explicit service RLS context: `{ userId: 'portal-notifier', role:
  'CRON_SERVICE', organizationId }`. The `push_*_portal_service` policies are the only
  thing that context can reach.
- Recipients: `User WHERE role = 'CUSTOMER' AND customerLeadId = (lead of an APPROVED
  booking on this unit)`. One push per user, deduped by subscription `endpoint`.
- Payload: `{ title: 'New photos for <unitNumber>', body: caption, url: '/portal?photo=<photoId>', tag: 'progress-<unitId>' }`.
- Every failure is caught and logged at WARN. The upload has already committed; a push
  failure must never surface to the staff member holding the phone.

### Web

- `apps/web/src/app/(portal)/layout.tsx`: client guard reading `useSessionUser()`.
  `null` role → `router.replace('/login?next=/portal')`. Any staff role →
  `router.replace('/')`. Renders `<nav aria-label="Portal">` with a single item in this
  slice (Progress); the component takes an items array so slice 3 adds Details,
  Payments and Docs without a rewrite.
- `apps/web/src/app/(portal)/portal/page.tsx`: fetches `me`, then the timeline for the
  selected unit. `?photo=<id>` opens that photo full-bleed on mount (deep-link target
  for push, D5 of the design review).
- `apps/web/src/components/portal/portal-timeline.tsx`: mirrors
  `apps/web/src/components/leads/lead-timeline.tsx` states exactly - skeleton cards
  shaped like the list, warm empty ("First photos coming soon" + "we'll notify you when
  the first photo lands"), inline error banner with retry, hasMore/load more. Rows, not
  cards: `<ol>`, photo, phase chip, date. Green chip only for the phase of the newest
  photo in the loaded set, neutral for the rest.
- `apps/web/src/components/portal/unit-switcher.tsx`: chips, one per unit, rendered
  only when the customer has more than one (design D4). Single unit means no control at
  all.
- `apps/web/src/components/portal/portal-lock.tsx`: the two dead-end states from the
  design state table - `customerLeadId` null ("photos not linked yet, contact the
  office" + the project office phone from `Project`/`Organization`) and zero units.
- `apps/web/src/hooks/queries/customer-portal.ts`: `useCustomerMe()`,
  `useCustomerTimeline(unitId, cursor)` via the existing `apps/web/src/apis/client.ts`
  conventions.
- Components come from `@paalstack/react-ui` Props API only (Button, Skeleton, Badge,
  toast), per `apps/web/AGENTS.md` and the design's token mapping.

Admin mechanics:

- `apps/web/src/app/[orgSlug]/admin/users/components/CreateUserForm.tsx`: CUSTOMER in
  the role list, OWNER/ADMIN sessions only. `ROLES_REQUIRING_TEAM` (`:26`) stays as it
  is, without CUSTOMER: a customer belongs to no team. A parallel
  `ROLES_REQUIRING_LEAD = ['CUSTOMER']` drives a required "Customer (lead)" combobox
  that searches leads by name or phone and submits `customerLeadId`.
- `apps/backend/src/users/users.service.ts`: `create` accepts `customerLeadId`, rejects
  it for non-CUSTOMER roles, rejects a lead in another org, and requires it for
  CUSTOMER. A role change away from CUSTOMER clears the pointer in the same write.
- Seed: `customer@shadhilbuilders.in` linked to a demo lead that has an `APPROVED`
  booking, plus ids printed in the todo doc, so the manual portal test needs no setup.

## Acceptance Criteria

1. `pnpm test` green, including new DB-first RLS tests in
   `packages/database/test/customer-portal-rls.test.ts`. Customer A reading customer B's
   unit returns exactly 0 rows with no error, on `Unit`, `Phase`, `Project`,
   `progress_photo` and `Booking`.
2. A CUSTOMER session reading `Lead`, `Message`, `Activity`, `SiteVisit`, `Reminder`
   and `AuditLog` returns exactly 0 rows, asserted as `length === 0`, not "denied some
   how".
3. Only `APPROVED` bookings grant access. With the same lead, `HOLD`, `TOKEN`,
   `REJECTED` and `CANCELLED` bookings yield 0 photos. Asserted per status, 5 cases.
4. `customer_can_read_unit()` returns false when `app.user_id` / `app.user_org_id` /
   `app.user_role` GUCs are unset, and false for a CUSTOMER whose `customerLeadId`
   points at a lead in a different org.
5. No CUSTOMER INSERT/UPDATE/DELETE arm exists: an attempt to update another
   customer's photo or insert one raises a row-level security violation, asserted as an
   explicit error rather than an empty result.
6. Service authorization: `/api/customer-portal/*` returns 403 for staff roles, 403 for
   a CUSTOMER with a null pointer, 404 for a unit outside the caller's bookings, 200 for
   an own unit. Four exact assertions.
7. Routing: a CUSTOMER session hitting `/` lands on `/portal`; the same session hitting
   `/[orgSlug]/leads` is redirected to `/portal`; a staff session hitting `/portal` is
   redirected to `/`. `proxy.ts` keeps `/portal` behind the session cookie.
8. Portal renders real data: with the seeded customer, `GET /api/customer-portal/me`
   returns one unit whose `unitNumber`, `projectName` and `currentPhaseName` match the
   seeded rows, and the timeline returns the photos slice 1 uploaded.
9. Push: uploading a photo as an engineer inserts one `PushNotification` row per
   customer user on an `APPROVED` booking for that unit, with
   `payload.url = '/portal?photo=<id>'`. A webhook push endpoint that returns 410 marks
   the subscription for deletion the way `PushService` already handles it. A push
   failure leaves the upload response 201 and logs one WARN.
10. Admin controls: CUSTOMER appears in the role list for OWNER/ADMIN only, the lead
    picker is required and org-scoped, and neither is visible to a MANAGER session.
11. No degradation: full existing suite passes; `pnpm lint`, `pnpm type-check` and
    `pnpm run build` green.

Each test states its card: `protects=<observable>; fails_when=<wrong result it
rejects>; no_claim=<what green does not prove>`.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| DB RLS (`packages/database/test/customer-portal-rls.test.ts`) | customer-vs-customer isolation on 5 tables; sales-table denial on 6; 5 booking statuses; helper fail-closed without GUCs; cross-org pointer; no write arms | +14 |
| Unit (backend) | `me` ordering + empty case; timeline cursor parity with the staff route; 403/403/404/200 matrix; notifier recipient selection; notifier swallows failure | +9 |
| Unit (web) | portal layout role guards (3 cases); timeline states (4); unit switcher visible only for 2+ units; lock screen for null pointer | +7 |
| E2E (manual, slice gate) | seeded customer logs in on Android Chrome, sees their unit timeline, receives a push on the next engineer upload and the tap opens the photo | +1 |

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test.
   Never make a test pass artificially, and never widen a policy to make a green.
2. The migration, the helper functions and the policy text are authored and reviewed by
   hand. Scaffolding (portal layout, components, hooks, DTOs) may be generated; the RLS
   and the authorization matrix may not.
3. Real code and real tests land in the same change. No placeholder policy, no
   `WITH CHECK (true)` anywhere, no test deferred to a follow-up.
4. Any change to a validator, CI step, timeout, threshold, snapshot or suppression
   pragma is reported on its own line with its justification.
5. A reported command names the command and its observed result. stderr is never
   silenced.
6. If a slice-1 policy turns out to be wrong while writing a customer arm, fix it in a
   separate commit in the same PR and say so in the report. Do not fold it silently.

## Rollback Plan

Code revert removes the portal routes, the module, the notifier and the admin controls.
The migration is forward-only: reverting code without the migration leaves the CUSTOMER
enum value, `User.customerLeadId`, the two helpers and their policies in place, inert,
because no code path sets `role = 'CUSTOMER'` any more. Do not drop the customer
policies in a hotfix: absent policies deny, which is the safe direction.

## Effort Estimate

- Schema + migration + 2 helpers + 6 policies + policies.sql mirror: ~4h
- Role touchpoints (8 files) + admin provisioning + seed: ~3h
- customer-portal module (me + timeline + authorization) + mapper extraction: ~4h
- PortalNotifier + push service-path + enqueue on upload: ~3h
- Web portal (layout, timeline, switcher, lock, hooks): ~6h
- DB-first RLS tests + backend/web unit tests: ~6h
Total: ~26h human-equivalent.

## Files Reference

| File | Change |
|---|---|
| `packages/database/prisma/schema.prisma` | `Role += CUSTOMER`, `User.customerLeadId`, `Lead.customerUsers` |
| `packages/database/prisma/migrations/<new>_customer_portal_slice2/migration.sql` | enum, column, FK, index, 2 helpers, 6 policies, grants |
| `packages/database/prisma/rls/policies.sql` | mirror the 4 slice-1 policies, then the 6 new ones |
| `packages/database/src/rls.ts:96-104` | `ROLES += 'CUSTOMER'` |
| `packages/database/test/customer-portal-rls.test.ts` | new: 14 DB-first cases |
| `packages/auth-client/src/jwt.ts:25-31` | `ROLES += 'CUSTOMER'` |
| `packages/api-types/src/enums.ts:20-26,36` | `RoleSchema += 'CUSTOMER'` |
| `apps/backend/src/app.module.ts` | register `CustomerPortalModule` |
| `apps/backend/src/customer-portal/*` | new module, controller, service, portal-notifier |
| `apps/backend/src/customer-progress/progress-photo.mapper.ts` | extracted from `customer-progress.service.ts`, no behaviour change |
| `apps/backend/src/customer-progress/customer-progress.service.ts` | call `PortalNotifier.notifyNewPhoto` after commit |
| `apps/backend/src/users/roles.ts:18-26,85-130` | `RANK.CUSTOMER`, admin-only create/change guards |
| `apps/backend/src/users/users.service.ts` | `customerLeadId` validation on create and role change |
| `apps/backend/src/push/push.service.ts` | `sendToUsers(organizationId, userIds, payload)` on the service path |
| `apps/web/src/lib/session.ts:86,183-190`, `apps/web/src/lib/nav.ts:331-341` | `ROLE_RANK.CUSTOMER = 0`, ENGINEER corrected to 1, CUSTOMER out of linkable-staff and nav lists |
| `apps/web/src/lib/labels.ts:280-296` | CUSTOMER label |
| `apps/web/src/app/page.tsx` | CUSTOMER branch to `/portal` |
| `apps/web/src/app/[orgSlug]/layout.tsx` | bounce CUSTOMER to `/portal` |
| `apps/web/src/proxy.ts` | `/portal` behind the session gate |
| `apps/web/src/app/(portal)/layout.tsx`, `portal/page.tsx` | new portal shell and timeline route |
| `apps/web/src/components/portal/*` | timeline, unit switcher, lock screen, nav |
| `apps/web/src/hooks/queries/customer-portal.ts` | new query hooks |
| `apps/web/src/app/[orgSlug]/admin/users/components/CreateUserForm.tsx` | CUSTOMER option + required lead picker |
| `packages/database/src/seed.ts` | demo customer + APPROVED booking |

## Out of Scope

- Slice 3 portal surfaces: booking details, unit summary, payments, documents.
- Staff "View as customer" preview link. It needs a staff-allowed portal read path and
  its own matrix; leaving it out keeps the portal CUSTOMER-only.
- Photo correction/delete UI and caption editing (slice 4).
- Self-service signup, phone OTP, magic links, invite email. D3 ships provisioned
  logins; nothing else exists to send mail or SMS.
- Push frequency tuning, digesting, quiet hours.
- HEIC ingestion and iOS camera conversion (slice-1 boundary, unchanged).
- Desktop portal layout beyond centering the timeline at `max-w-lg`.
- Multi-org customers: one login belongs to one organization, like every other user.

## Related

- #7 - slice 1 (merged, closed); #8 - PR that shipped it; #13 - close-out; #14 - the
  manual phone gate still open on slice 1.
- `docs/designs/customer-progress-portal.md` - approved design, site-staff model
  amendment, Pass-7 decisions D4/D5/D6.
- `docs/specs/SPEC-customer-progress-slice-1.md` and
  `docs/specs/slice-1-progress-todo.md` - the shipped slice, and the policies it created.
