# Task Plan: Organization-scoped Settings page for all users

## Goal

Give every authenticated role a real Settings page at `/[orgSlug]/settings` that closes the
existing DEAD LINK (`nav-user.tsx:104` + `app-header.tsx:334` both point at `/settings`, which
404s today) and provides the one self-service profile write the product has never had.

## Next Step

Implement Phase 2 (backend `PATCH /api/users/me`), then Phase 3 (the page).

## Current Phase

Phase 1 complete - implementation starting.

## Phases

### Phase 1: Requirements & Discovery

- [x] Verify the entry point (`/settings` links exist and 404 today)
- [x] Verify what backend capability exists (change-password: yes; self-profile: NO - explicitly
      rejected at `users.service.ts:359` with the comment "self-profile editing is a separate surface")
- [x] Verify RLS reality on `Organization` (live `pg_policies` query) and `User` (no RLS at all)
- [x] Verify better-auth 1.7.2 react client exposes `refetch()` (needed so a name save updates the sidebar)
- [x] Surface the three hard calls; owner ruled on all three
- **Status:** complete

### Phase 2: Backend - the one new capability

- [x] `UpdateProfileDtoSchema` in `@shadhil/api-types` (name only, reuses `nameSchema`)
- [x] `UsersService.updateSelf(actor, dto)` - scoped `where: { id: actor.sub }`, audit row in the
      actor's own RLS context, same-transaction write + audit
- [x] `PATCH /api/users/me` declared BEFORE `PATCH /:id` (this repo has a documented route-order trap
      where Nest matches in declaration order and `:id` would capture a literal segment)
- [x] Audit action `user.updateSelf` added to the audit page's `FILTER_ACTIONS` label map
- **Status:** complete

### Phase 3: Web - Settings page + entry point

- [x] `useUpdateProfile()` mutation + `refetch` exposed from `useSessionUser`
- [x] `/[orgSlug]/settings/page.tsx` - sections: Profile, Password, Notifications, Organization, Appearance
- [x] Wire the two dead `/settings` links through `orgHref(orgSlug, '/settings')`
- **Status:** complete

### Phase 5: Fixed the two pre-existing red suites — complete

- **Status:** complete
- Actions taken:
  - `my-teams/[teamId]/page.test.tsx` — its hand-rolled `vi.mock('@/hooks/queries/teams')`
    replaced the WHOLE module but only exported `useTeam`. `team-roster.tsx` gained
    `useUpdateTeamMemberWeight` on 2026-09-17 (T-AUTOASSIGN), so the render threw
    "No export is defined on the mock". The admin twin suite
    (`admin/teams/[teamId]/page.test.tsx`) WAS updated with the hook; this one was missed.
    Added the export + a `baseMocks()` return value, mirroring the admin suite.
  - `overdue-alerts.processor.test.ts` — the two DB-heavy tests (each ticks the cron and
    does multiple `withRlsContext` round-trips) ran on vitest's 5s default and blew it under
    a 50-file parallel run. The suite already sets `30_000` on its other hooks/tests; these
    two were missed. Raised them to `30_000` to match.
- Verified: both FULL suites now green — backend 1074/1074 (50 files), web 699/699 (79 files),
  both exit 0.
- Files modified:
  - `apps/web/src/app/[orgSlug]/my-teams/[teamId]/page.test.tsx`
  - `apps/backend/src/overdue-alerts/overdue-alerts.processor.test.ts`

## ⚠ OPEN — commit/push anomaly (owner decision required)

`main` (local AND origin) is at `893c568` "feat(planning): add organization settings page and
related documentation", created 12:07:53 UTC, authored as `Shadhil Builders
<shadhilbuilders@gmail.com>`. **I did not run `git commit` or `git push`.** Confirmed on the
remote read-only: `git ls-remote origin main` returns that SHA, so it is on upstream `main`.

It contains the settings feature but NOT the two test fixes above (written after 12:07), so
upstream `main` is still RED on those two suites. Those two files are intentionally left
uncommitted — how the rest reaches `main` is the owner's call, and rewriting shared history
unasked would be worse than reporting it.

Ask the owner: did they commit/push it, or is a hook/tool doing it? Then decide how the two
test fixes land.


### Phase 4: Verification — complete

- [x] Unit tests at each seam (schema, service, controller route order, page) - 93 backend + 17 web
- [x] `pnpm type-check` + `pnpm lint` + targeted `pnpm test` green
- [x] Drive the real page in a browser against the live dev stack - DONE, authenticated as OWNER
- **Status:** complete

## Browser verification (authenticated, live stack) - PASSED

Signed in as `owner@shadhilbuilders.in` (OWNER) and drove the real page:

- Route resolves and renders all five sections; no not-found.
- Real data: org name "Shadhil Builders", slug "/shadhil-builders", role rendered as the FRIENDLY
  "Owner" (not `OWNER`), user id, email.
- All five read-only fields have `readOnly === true`.
- Inbox link resolves to a real project: `/shadhil-builders/projects/shadhil-metro-heights/notifications`.
- **Name-save round trip PROVEN end to end**: changed the name in the UI → sidebar updated
  immediately ("Owner (settings probe)") → DB row updated → audit row written with a real
  before/after pair. Restored the original name afterwards and confirmed both directions are in the
  append-only audit trail. No test data left behind.
- Backend route registration proven from the Nest startup log:
  `{/api/users/me, PATCH}` is mapped BEFORE `{/api/users/:id, PATCH}`.
- Frontend route registration proven from the Next build route table: `/[orgSlug]/settings`.

## Defect found and fixed during browser verification

The push state hung on "Checking..." forever - a PRE-EXISTING bug in the SHARED hook, not this page:

`usePushSubscription` awaited `navigator.serviceWorker.ready`, which NEVER SETTLES (it does not
reject) when no service worker is registered. `ServiceWorkerRegistrar` deliberately skips
registration in development, so in dev `setChecked(true)` was never reached. Root-caused live by
probing the browser (`getRegistrations()` = 0, `ready` pending after 8s). The surrounding `try/catch`
could not help - a promise that never settles never throws.

Fixed with `swReadyOrNull()`: resolves immediately when a worker is already active (zero added
latency in production), otherwise waits a bounded 3s then returns null so callers report
"unsupported" instead of spinning. Verified in the real browser: the badge now reads
"Not supported here" with no dead Enable button.



## Key Questions

1. Does better-auth's react client expose a way to re-read the session after a write? -> YES,
   `useSession()` returns `refetch()` in better-auth 1.7.2 (`dist/client/react/index.d.mts`).
2. Does an org rename need a migration? -> YES (no UPDATE policy on Organization), so it is out of
   scope by owner ruling.

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Org section read-only in v1 | `Organization` is FORCE RLS with SELECT-own/INSERT-public/CRON only. No UPDATE policy => a write is a silent 0-row update. Rename = security-policy migration, deferred by owner. |
| Self-profile write = name only | Name has real consumers everywhere; phone is read by no feature (inert); email is excluded because no email-verification flow exists, so a self-edit could move a login to an unverified address. |
| Quiet hours deferred to v1.1 | No columns, no enforcement anywhere. A toggle with no server effect is fake UI (honest-state contract). Decision #26 already defers per-trigger notification settings. |
| No new sidebar nav item | Settings is reached from the user menus by design, and `lib/nav.test.ts` asserts exact nav arrays - a new row would break them for no benefit. |
| Single scrolling page, no tabs | Matches every other page in this repo; tabs would add URL state with no gain. |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes

- Do NOT weaken any test to make this pass; if a check fails, investigate.
- `PATCH /users/me` must sit above `PATCH /users/:id` on the controller.
