# Cursor Agent prompt - slice 2 (Customer Progress Portal)

Paste everything below the line into Cursor Agent. It is written to be the whole brief;
the agent should not need to ask a clarifying question to start.

---

You are implementing slice 2 of the Customer Progress Portal in the shadhil-crm monorepo.
This is a real product surface for paying home buyers, in a codebase where a wrong
permission means one buyer sees another buyer's construction photos. Work carefully,
follow the spec, and stop rather than guess.

## Repository and branch

- Repo root: the directory this file lives under (`docs/specs/` is inside it).
- Branch: `feat/customer-progress-slice-2`, which already exists locally and is based on
  `main` @ `349b9e4`. It currently holds one uncommitted file, the spec you are about to
  read.
- Slice 1 is already shipped on `main` (PR #8, `198e335`): the ENGINEER role, the
  `ProgressPhoto` model, the staff upload route and the staff timeline. You are extending
  that data to buyers. You are not rebuilding it.

## Read these first, in this order

1. `docs/specs/SPEC-customer-progress-slice-2.md` - the authoritative spec. Sections:
   Decisions locked, Schema, RLS, Role migration, Backend, Web, Acceptance Criteria,
   Testing Plan, Files Reference, Out of Scope. Where this prompt and the spec disagree,
   the spec wins.
2. `docs/designs/customer-progress-portal.md` - the approved design. Read the
   "Design Specification" section (state table, information hierarchy, Pass-7 decisions
   D4/D5/D6) and "Success Criteria".
3. `AGENTS.md` (repo root) - module conventions, RLS rules, test rules, database rules.
   Non-negotiable.
4. `apps/web/AGENTS.md` - Next.js 16 notes. Also read the relevant guide under
   `apps/web/node_modules/next/dist/docs/` before writing route or layout code.
5. `CLAUDE.md` - skill routing rules.
6. The shipped slice-1 artifacts, as patterns to copy rather than invent:
   - `packages/database/prisma/migrations/20261026160800_customer_progress_slice1/migration.sql`
   - `packages/database/prisma/migrations/20261027160000_engineer_team_select/migration.sql`
   - `apps/backend/src/customer-progress/` (module, controller, service)
   - `apps/web/src/components/inventory/UnitProgressTab.tsx`
   - `apps/web/src/components/leads/lead-timeline.tsx` (the timeline states to mirror)
   - `packages/database/test/progress-rls.test.ts` (the DB-first test shape to copy)

## Skills and rules to load before you write code

From the repo's ECC pack, use these. Load them with the Cursor skill mechanism, or read
the files directly if you cannot invoke them.

Rules (`.cursor/rules/`, always-on unless noted):

- `common-agents.mdc`, `common-coding-style.mdc`, `common-development-workflow.mdc`,
  `common-testing.mdc`, `common-security.mdc`, `common-patterns.mdc`,
  `common-performance.mdc`, `common-git-workflow.mdc`
- `typescript-coding-style.mdc`, `typescript-patterns.mdc`, `typescript-testing.mdc`,
  `typescript-security.mdc`, `typescript-hooks.mdc`
- `react-coding-style.mdc`, `react-patterns.mdc`, `react-testing.mdc`,
  `react-security.mdc`, `react-hooks.mdc`
- `web-security.mdc`, `web-testing.mdc`

Skills (`.cursor/skills/`):

- `database-migrations`, `prisma-patterns`, `postgres-patterns` - for the migration, the
  helpers and the RLS work. These three are the highest-risk part of the task.
- `nestjs-patterns`, `backend-patterns`, `api-design` - for `customer-portal`.
- `nextjs-turbopack`, `react-patterns`, `react-testing`, `react-performance` - for the
  portal routes and components.
- `tdd-workflow`, `verification-loop`, `e2e-testing`, `delivery-gate` - for the gates at
  the end.
- `accessibility` - the design has explicit a11y requirements (bottom nav as `<nav>`,
  timeline as `<ol>`, aria-labels, 44px touch targets, contrast from `brand.css`).

If a skill contradicts the spec, the spec wins. If a skill contradicts `AGENTS.md`,
`AGENTS.md` wins.

## Hard constraints

1. **Local only.** Do not commit, do not push, do not open a pull request, do not deploy,
   do not run any command that touches a remote. This repo's PR pipeline is slow and runs
   sparingly. Leave your work as a local working tree and report it.
2. **Never touch `main`.** Work on `feat/customer-progress-slice-2` only.
3. **Never widen a policy to make a test pass.** If a test fails, the code or the policy is
   wrong, not the test.
4. **No `WITH CHECK (true)` anywhere. No placeholder policy. No stub test. No TODO in
   shipped code.** Real code and real tests in the same change.
5. **Every business query runs inside `withRlsContext()`.** The bare `prisma` client is
   allowed only for migrations, seed, better-auth session/account writes, webhook ingest,
   system crons, and the one `PortalNotifier` system path named in the spec.
6. **One migration.** The enum value, the column, the FK, the index, the two helper
   functions, the six policies and the grants ship in a single migration file under
   `packages/database/prisma/migrations/<timestamp>_customer_portal_slice2/`. Never
   `prisma db push`.
7. **Policies are permissive-OR.** Adding a customer arm must not change what any staff
   role can read. Check each new policy against the existing arms on that table before you
   move on.
8. Ask before you invent. If the spec does not settle something, stop and ask. Do not pick
   silently.

## What to build, in this order

Do these as five separate passes, running the gate after each so a break is attributable.

**Pass 1 - schema and migration.**
`Role += CUSTOMER`, `User.customerLeadId` (nullable, indexed, `onDelete: SetNull`),
`Lead.customerUsers` back-relation. Then the migration: enum value, column, FK, index, the
two SECURITY DEFINER helpers (`customer_lead_id()`, `customer_can_read_unit(text)`) with
`search_path = public`, `STABLE`, `REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO
shadhil_app`, then the six policies from the spec, then table grants if any new table is
added (none should be). Copy the function shape from `team_member_exists()` in migration
`20261027160000`. Postgres will not let you add an enum value and use it in the same
transaction in some cases: if `ALTER TYPE ... ADD VALUE` fails inside the migration
transaction, follow the note already in the slice-1 migration header.

**Pass 2 - the RLS matrix, before any service code.**
New file `packages/database/test/customer-portal-rls.test.ts` with the 14 cases in the
spec's Testing Plan. Copy the harness shape from
`packages/database/test/progress-rls.test.ts`. Every assertion is exact: `length === 0`,
not "denied somehow"; an expected RLS violation asserts the thrown error, not an empty
result. Run `pnpm db:test:reset` then `pnpm --filter @shadhil/database test`. This must be
green before you write a single line of the NestJS module. If it is not green, stop and
report which case fails and what the actual rows were.

**Pass 3 - role touchpoints (8 files).**
Exactly the eight in the spec's table: `schema.prisma` (already done in pass 1),
`packages/database/src/rls.ts`, `packages/auth-client/src/jwt.ts`,
`packages/api-types/src/enums.ts`, `apps/web/src/lib/labels.ts`,
`apps/web/src/lib/session.ts` + `apps/web/src/lib/nav.ts`,
`apps/backend/src/users/roles.ts`, and the three routing files. Adding CUSTOMER to only
some of these fail-closes every RLS context or lets a customer into the CRM. Run
`pnpm type-check` after this pass; the exhaustiveness checks are designed to catch a
missed mirror and they will.

**Pass 4 - backend.**
`apps/backend/src/customer-portal/{module,controller,service}.ts` plus
`portal-notifier.service.ts`, registered in `app.module.ts`. Extract the photo mapping
from `customer-progress.service.ts` into
`apps/backend/src/customer-progress/progress-photo.mapper.ts` with no behaviour change,
so both timelines emit one DTO shape. Then `PortalNotifier` and the enqueue call after
the upload commits. The push system path is the only place you may use a service RLS
context, and it must use exactly `{ userId: 'portal-notifier', role: 'CRON_SERVICE' }`
with the org from the photo, or the policies will deny it. Push failures log WARN and
never change the upload response.

**Pass 5 - web.**
The `(portal)` route group, the layout guard, the timeline, the unit switcher, the lock
screen, the query hooks, the `/` and `[orgSlug]` redirect branches, the `/portal` entry
in `proxy.ts`, and the admin CUSTOMER option with the required lead picker. Components
come from `@paalstack/react-ui` Props API only. Mirror `lead-timeline.tsx` for the four
states. Do not build a dashboard, a search box, a filter or a settings page: the design
explicitly forbids all four on the customer home.

## Verification gates

Run these; report the command and its real output, not a claim.

```
pnpm --filter @shadhil/database type-check
pnpm db:test:reset
pnpm --filter @shadhil/database test          # includes the RLS matrix
pnpm --filter @shadhil/backend test
pnpm --filter @shadhil/web test
pnpm type-check
pnpm lint
pnpm run build
hermes verify --skip-start --json             # if available; bootstrap+build+test+lint
```

Notes on the last two:

- `pnpm run build` regenerates `apps/web/next-env.d.ts` and `apps/web/public/sw.js`.
  After any build, restore them: `git checkout -- apps/web/next-env.d.ts apps/web/public/sw.js`.
  They are build residue, not your change.
- `hermes verify --skip-start` is the sanctioned gate in this repo because `pnpm dev`
  needs the docker postgres/pgbouncer/redis stack plus a migrated DB. Do not start the
  dev stack to prove a build.

## Repo pitfalls that have already bitten this project

- **RLS recursion.** A policy that subqueries a FORCE-RLS table re-enters RLS. A raw
  `EXISTS` on `TeamMember` inside a `ProjectTeam` policy produced `42P17` in slice 1. That
  is why the customer predicate lives in SECURITY DEFINER helpers. Do not inline the join.
- **`policies.sql` is canonical and is currently incomplete.** The four slice-1 policies
  for `Unit`, `Phase`, `Project` and `ProjectTeam` exist only in the migration. Mirror
  them into `packages/database/prisma/rls/policies.sql` verbatim (no behaviour change),
  then add the six customer policies there too, so the file matches what is deployed.
- **Vitest in `packages/database` includes `test/**/*.test.ts` only** and runs serially
  against one physical database (`shadhil_crm_test`). A new test file goes in `test/`.
- **The RLS matrix must never silently skip.** CI sets `RLS_MATRIX_REQUIRED=true`; a
  missing DB has to be red, not skipped.
- **Never run the repo-wide `prettier --write`.** It rewrites 137 unrelated files and then
  fails on `prettier-plugin-tailwindcss`. Format only the files you touched, from inside
  the app that owns them.
- **Turbo caches test results.** If you touch a test file, make sure the cache did not
  replay an old green. Read the line that says `cache hit` or `cache miss`.
- **`POOL_MODE=session` is required**; the boot check enforces it. Do not change it.
- **Do not send `role` from any signup input.** better-auth's `role` additional field is
  `input: false`; roles are set by admins and the seed only.
- **The role enum is closed in 8 places.** Missing one throws at runtime or fails
  `tsc`. Treat every `ENGINEER` occurrence as a place `CUSTOMER` may also be needed, and
  check each one instead of blind-replacing.

## Definition of done

- The 11 acceptance criteria in the spec each have a test or a named verification, and you
  can say for each one which test covers it.
- All gates above are green, with the commands and outputs quoted.
- `git status --short` shows only files this task touched, plus the spec that was already
  uncommitted when you started.
- No commit has been made, nothing has been pushed, no PR exists.

## How to report

Report in this order, briefly:

1. What you built, file by file, in one line each.
2. Gate results: the exact command, exit status, and the count it printed (tests passed,
   tasks successful). If a command failed, say so before anything else.
3. For each new test: `protects=...; fails_when=...; no_claim=...`.
4. Anything in the spec you could not implement, and why.
5. Anything you changed in a validator, CI step, threshold or suppression, on its own
   line with the reason.
6. Anything you think the spec got wrong. Say it plainly; do not silently diverge.

Do not summarise the whole task back. Do not write a changelog. If something failed,
lead with it.
