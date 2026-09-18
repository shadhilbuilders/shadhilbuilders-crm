# Progress Log

Chronological record for the org-scoped Settings page (2026-09-18).

## Session: 2026-09-18

### Phase 1: Requirements & Discovery — complete

- **Status:** complete
- **Started:** 2026-09-18 ~10:45Z
- Actions taken:
  - Found the entry point already exists as a DEAD LINK: both user menus render
    `href="/settings"` and no such route exists (404 today).
  - Confirmed there is no self-service profile edit anywhere: `PATCH /api/users/:id`
    explicitly throws on self-edit (`users.service.ts:359`, comment: "self-profile
    editing is a separate surface").
  - Queried the LIVE database (`pg_policies`) rather than trusting the schema:
    `Organization` is FORCE RLS with only `org_select_own` / `org_insert_public` /
    `org_cron_service_all` — NO update policy. `User` has NO RLS at all
    (`relrowsecurity = false`).
  - Confirmed better-auth 1.7.2's react client exposes `refetch()` on `useSession()`
    (read `dist/client/react/index.d.mts`), so a saved name can update the shell.
  - Verified quiet hours has no columns and no enforcement anywhere (DESIGN.md §12
    describes it; Decision #26 defers per-trigger settings to v1.1).
  - Surfaced the three hard calls; owner ruled on all three (see task_plan.md).
- Files created/modified: none (discovery only)

### Phase 2: Backend — complete

- **Status:** complete
- Actions taken:
  - `UpdateProfileDtoSchema` (name only) added to `@shadhil/api-types`, reusing the
    existing `nameSchema` so the self-edit rule cannot drift from the admin rule.
  - `UsersService.updateSelf()`: target from the JWT `sub`, no id parameter anywhere,
    write pinned to `actor.sub` (TOCTOU-safe), audit row in the SAME transaction.
    New `UpdatedProfile` result type.
  - `PATCH /api/users/me` declared BEFORE `@Patch(':id')` on the controller.
  - Audit action `user.updateSelf` added to the admin audit page's label map.
- Files created/modified:
  - `packages/api-types/src/auth.ts`
  - `apps/backend/src/users/users.service.ts`
  - `apps/backend/src/users/users.controller.ts`
  - `apps/web/src/app/[orgSlug]/admin/audit/page.tsx`
  - NEW `apps/backend/src/users/users.controller.route-order.test.ts`
  - NEW `apps/backend/src/users/users.service.update-self.test.ts`

### Phase 3: Web — complete

- **Status:** complete
- Actions taken:
  - New page with five sections: Profile (name), Password (existing endpoint, same
    schemas as /change-password), Notifications (real per-device push state), 
    Organization (read-only by ruling), Appearance (dark mode).
  - `useUpdateProfile()` hook; `refetchSession()` added to `useSessionUser`.
  - Both dead `/settings` links now take a resolved org-scoped `settingsHref` and
    render inert while the slug is unresolved (never a link to a 404).
- Files created/modified:
  - NEW `apps/web/src/app/[orgSlug]/settings/page.tsx`
  - NEW `apps/web/src/app/[orgSlug]/settings/page.test.tsx`
  - `apps/web/src/hooks/queries/users.ts`
  - `apps/web/src/lib/session.ts`
  - `apps/web/src/components/sidebar/nav-user.tsx`
  - `apps/web/src/components/app-header.tsx`
  - `apps/web/src/components/app-shell.tsx`

### Phase 4: Verification — complete

- **Status:** complete
- Actions taken:
  - Backend `src/users/`: 7 files, 93 tests pass (live DB).
  - Web settings page: 17 tests pass.
  - `pnpm type-check` clean (web AND backend). `pnpm lint` clean (web).
  - Proved the route-order test can FAIL: temporarily swapped the two `@Patch`
    declarations → `expected 4 to be less than 3`, exit 1. Restored and re-verified.
  - Real-browser verification PASSED (authenticated as OWNER) - see task_plan.md.
  - Repo-wide runs (background batch) ended red on TWO pre-existing suites, both
    attributed with my changes PRESENT, not on a stashed tree:
    * `my-teams/[teamId]/page.test.tsx` - 2/3 fail identically on pristine HEAD too
      (verified by stashing). The file imports none of my touched modules.
    * `overdue-alerts.processor.test.ts` - 3/3 PASS in isolation WITH my changes
      applied. It imports only notifications/prisma/redis, nothing from `users`
      or `api-types` auth, so my diff cannot reach it. Under the 50-file parallel
      run both of its DB-heavy tests time out at the 5s default (the same file
      produced a DIFFERENT pair of names on each run - the signature of a
      load-sensitive timeout, not a deterministic assertion failure).
  - Full-suite totals: backend 1072 pass / 2 fail; web 680 pass / 2 fail.
  - ATTEMPTED the real-browser check: the proxy correctly redirects to
    `/login?next=...` and no saved login exists in the vault, so the AUTHENTICATED
    render is still unverified. A fake-cookie probe was INCONCLUSIVE: it showed
    "Page not found", but the control route `/shadhil-builders/work` (which certainly
    exists) shows the same, because the org layout's `getOrganizationBySlug` fails on a
    fake session and calls `notFound()`. Not evidence either way.
  - The earlier fake-cookie probe is recorded below as INCONCLUSIVE - it was
    superseded by the real authenticated session, which proved the route resolves.
- **Status:** complete

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| `users.controller.route-order.test.ts` | `@Patch('me')` before `@Patch(':id')` | 5 pass | 5 pass | pass |
| same, with declarations SWAPPED | wrong order | FAIL | `expected 4 to be less than 3` | pass (can fail) |
| `users.service.update-self.test.ts` | live DB, 7 cases | 7 pass | 7 pass | pass |
| `settings/page.test.tsx` | 17 cases incl. push states + read-only fields | 17 pass | 17 pass | pass |
| backend `src/users/` scope | all users suites, my changes present | green | 93 tests, 7 files | pass |
| `my-teams/[teamId]/page.test.tsx` | unchanged file, also run on stashed HEAD | green | 2 fail both with and without my diff | pre-existing |
| `overdue-alerts.processor.test.ts` | unchanged file, isolation run WITH my changes | green | 3/3 pass; only times out under 50-file load | pre-existing flake |
| web full suite | `pnpm test` | green | 680 pass / 2 fail (the pre-existing pair) | 2 pre-existing |
| backend full suite | `pnpm test` | green | 1072 pass / 2 fail (the pre-existing pair) | 2 pre-existing |
| `pnpm build` (web) | production build | route table includes settings | `✓ Compiled successfully`, `/[orgSlug]/settings` listed, exit 0 | pass |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-09-18 ~11:08Z | Bare-client fixture INSERT into `Team` → `42501 new row violates row-level security policy` | 1 | My assumption that the bare client could seed was WRONG: `Team`/`TeamMember` are FORCE RLS. Moved setup/teardown/re-reads through an ADMIN `withRlsContext` context (same pattern as `users.service.rls.test.ts`). |
| 2026-09-18 ~11:17Z | Settings page test: `[data-qa="settings-push-enable"]` present with `permission: 'denied'` | 1 | REAL PAGE DEFECT, not a test bug. The badge said "Blocked in this browser" while still offering a button that cannot work. Fixed the page with an explicit `canOfferEnable` guard excluding `denied`. |
| 2026-09-18 ~11:17Z | Settings page test: `button[role="switch"]` length 0, expected 1 | 1 | Test selector was a GUESS. Dumped the real DOM: Base UI's Switch renders `<span role="switch">`, not `<button>`. Corrected the selector and added a second assertion (aria-checked true when dark) so the switch is genuinely exercised. |
| 2026-09-18 ~11:20Z | Vitest swallowed `console.log`, so the DOM probe printed nothing | 1 | Wrote the probe output to /tmp/probe-out.txt from inside the test instead of relying on console passthrough. Probe deleted after use. |
| 2026-09-18 ~11:24Z | Fake-cookie route probe showed "Page not found" for `/settings` | 1 | INCONCLUSIVE, not a defect. The control route `/work` shows the same text under a fake session (org lookup fails → `notFound()`). A test that cannot distinguish pass from fail proves nothing; do not read it as a route failure. Superseded by the real authenticated session. |
| 2026-09-18 ~11:35Z | Authenticated page: push badge stuck on "Checking..." forever | 1 | PRE-EXISTING bug in the SHARED hook, surfaced by this page. `usePushSubscription` awaited `navigator.serviceWorker.ready`, which NEVER SETTLES when no worker is registered, and `ServiceWorkerRegistrar` skips registration in dev. The surrounding try/catch was useless - a promise that never settles never throws. Root-caused live (`getRegistrations()` = 0, `ready` pending after 8s). Fixed with a bounded `swReadyOrNull()`: instant when a worker is already active (zero cost in prod), else 3s then `null` so callers report "unsupported". Verified in the browser: badge now reads "Not supported here", no dead Enable button. |
| 2026-09-18 ~11:39Z | Session lost mid-verification, page redirected to `/login` | 1 | The dev-server recompile triggered by my push-hook edit dropped the in-memory session. Re-authenticated through the vault and re-ran the check. Not a product defect. |
| 2026-09-18 ~11:52Z | Backend full suite named a DIFFERENT failing test pair than the earlier run | 1 | Signature of a load-sensitive TIMEOUT, not a deterministic failure. Confirmed by running the file in isolation WITH my changes applied: 3/3 pass. It imports only notifications/prisma/redis - nothing in my diff. |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | All four phases COMPLETE. Implemented, unit/integration/type/lint green, and verified in a real browser as an authenticated OWNER. |
| Where am I going? | Hand the diff over for review (nothing committed, per the standing rule). Optionally split the shared push-hook fix into its own change if the owner prefers. |
| What's the goal? | A real Settings page at `/[orgSlug]/settings` for every role, closing the existing dead link, with one genuine self-service profile write (name) and no fake controls. |
| What have I learned? | (1) `Team`/`TeamMember` are FORCE RLS — the bare client cannot seed them; use an ADMIN context. (2) Base UI Switch is a `<span role="switch">`, not a button. (3) A test can catch a REAL page defect — the denied-permission Enable button. (4) A fake session makes the org layout `notFound()`, so "Page not found" is not evidence about route existence. (5) Attribute pre-existing failures by running them on a stashed tree AND in isolation WITH your changes — never assume. (6) **`navigator.serviceWorker.ready` never settles (it does not reject) when nothing is registered — a `try/catch` cannot save you; bound it with a timeout.** (7) A load-sensitive timeout shows up as a *different* random test name each run. |
| What have I done? | 10 files modified, 4 paths created (settings page + 3 test files); 323 insertions, 21 deletions. Nothing committed. See the phase sections above. |
