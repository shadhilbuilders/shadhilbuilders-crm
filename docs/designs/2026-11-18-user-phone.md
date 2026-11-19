# User phone numbers

Status: revision 5, after three adversarial review passes (2026-11-18).
Branch: `main`. Mode: HOLD SCOPE on a narrowed design.
Reviewers: Claude subagent ×2, Codex ×1 (returned at ~8.4min, truncated by its
600s timeout; its one substantive finding is fixed in rev 5 — see the migration
workflow section).

## Revision history — every retracted claim, with evidence

| #   | Earlier claim                                                                          | Why it died                                                                                                                                                                                                                              | Now                                                        |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Store customer phone on `User`                                                         | Breaks spec D2 (two logins per lead, `customer-portal-rls.test.ts:250`); no valid sync rule                                                                                                                                              | Customer phone **derived**, never stored                   |
| 2   | `@@unique([phone, organizationId])`                                                    | Blocks the joint-buyer second login; leavers hold numbers forever; `''` collides                                                                                                                                                         | **Partial** index, staff-only, active-only                 |
| 3   | Expose `phone` via better-auth `additionalFields`                                      | Fields are embedded in a **7-day** JWT (`auth.ts:155`, `:249`)                                                                                                                                                                           | Read via `GET /users/:id`                                  |
| 4   | CUSTOMER sees their phone on the settings page                                         | **No such page** — `redirectForArea('staff','CUSTOMER')` → `/portal` (`portal-routing.ts:86`)                                                                                                                                            | Users table only (see rev 4)                               |
| 5   | Derive customer phone inside `getUser()` as a CUSTOMER                                 | `Lead` has **no CUSTOMER SELECT policy** (`policies.sql:78-1301`, only staff arms); a customer's own query returns zero rows _silently_                                                                                                  | `getUser()` derives for ADMIN/OWNER; customers not covered |
| 6   | Add phone to `PortalMeDto`                                                             | The portal **never reads `Lead`** (verified: `me()` touches Booking/Unit/Phase/Photo/Milestone only) and no CUSTOMER Lead policy exists. Would need a new SECURITY DEFINER helper + policy — for a number the portal has never displayed | **Cut.** Not in scope (rev 4)                              |
| 7   | P2002 mapper reads `meta.driverAdapterError.cause.constraint` + `meta.target` fallback | `constraint` is `{ index: '<name>' }`, not a string (`adapter-pg@7.10.0 dist/index.mjs:438-441`); `meta.target` has **0 occurrences** in the 7.10.0 runtime                                                                              | `.constraint.index`, no fallback                           |
| 8   | `UserListResult.rows` phone is safe; only `teamMembers` leaks                          | `useUsers` backs **six** pickers, all reading that payload                                                                                                                                                                               | `includePhone` opt-in                                      |
| 9   | Migration is "one new index"                                                           | `prisma migrate diff` is schema-driven; emits **nothing** for a partial index                                                                                                                                                            | Hand-written migration file                                |
| 10  | `valueFormat` prop on `PhoneNumberInput`                                               | Bakes a storage concern into a generic input; `max=12` escape hatch already exists                                                                                                                                                       | Normalize at the call site                                 |
| 11  | `prisma migrate dev --create-only`, then edit the generated file                       | `--create-only` is **schema-change driven**; `User.phone` already exists, so it reports "Already in sync" and writes **no file**. `migrate new` does not exist in Prisma 7.10                                                            | Create the migration directory + `migration.sql` by hand   |

## The problem

`User.phone` has existed since `20260831085813_init` and nothing reads or writes
it — no DTO field, no service write, no UI, no test. The plan of record committed
to it (§Input #6: staff numbers for FreJun KYC) but it was never wired, and the
`@unique` it sketched never landed. An admin cannot record a staff mobile anywhere
in the CRM.

Owner decision (D1): wire it for staff **and** customer logins.
Owner decision (D2, rev 3): customer phone is **derived from the lead**.
Owner decision (D3, rev 4): the derived customer number appears in **read-only
staff surfaces** only. No portal change, no new RLS policy.

## Scope boundary — what "staff and customers" now means

D1 said "staff and customer logins". After three review rounds the honest reading is:

|                         | Staff                  | CUSTOMER                          |
| ----------------------- | ---------------------- | --------------------------------- |
| Store a number          | ✅ `User.phone`        | ❌ derived from `Lead`            |
| Admin sees it           | ✅ users table, detail | ✅ users table, detail (derived)  |
| Admin edits it          | ✅ user form           | via the **lead**, not the account |
| Self-edits it           | ✅ settings page       | ✗                                 |
| Sees it in their own UI | ✅ settings page       | ✗ (portal never showed it)        |

The customer column exists so an admin can see who they're dealing with from one
screen. It is not a customer-facing feature. If a customer-facing number is wanted
later, that is `PortalMeDto` + one SECURITY DEFINER helper — written down in
TODOS.md with the RLS constraint that makes it non-trivial.

## Reuse map

| Sub-problem                | Existing code                                              | Verdict                        |
| -------------------------- | ---------------------------------------------------------- | ------------------------------ |
| Validation + normalization | `PhoneSchema` / `normalizePhoneDigits` (`common.ts:22-85`) | Reuse verbatim                 |
| Phone input                | `PhoneNumberInput`                                         | Reuse after Defect 1           |
| Phone display / dialer     | `formatPhone`, `telUrl` (`lib/phone.ts`)                   | Reuse after Defect 2           |
| User writes                | `users.service.ts` `create` / `update` / `updateSelf`      | Extend                         |
| Partial unique index       | `one_owner_per_org`, `SiteVisit_one_open_per_lead`         | Same pattern, hand-written     |
| Batched per-row lookup     | `list()`'s `ledTeams` batch (`users.service.ts:~1500`)     | Same shape for customer phones |

---

## Pre-existing defects on the reuse path

### Defect 1 — `PhoneNumberInput` corrupts a stored number (LIVE PII BUG)

`LeadEditTarget.phone` carries the raw DB value (`leads/page.tsx:350-356`) → RHF
default (`LeadEditDialog.tsx:71`) → `value={value || ''}`. A programmatic value is
not truncated by `maxLength`, so 12 digits render; the **first keystroke** then
applies `digitsOnly(v, 10)` (`PhoneNumberInput.tsx:75-76`):

```
stored in DB          : 919876543210
after ONE keystroke   : 9198765432        (digitsOnly(...,10))
resubmitted as        : 919198765432      (matches /^[6-9]\d{9}$/)
SAME NUMBER?          : false
```

Submitting untouched is safe (normalization is idempotent on the 12-digit form).

**Fix at the boundary.** The component's documented contract is "just guards the
wire value while typing; it does NOT normalize" (`PhoneNumberInput.tsx:14-19`). The
defect is a shape mismatch, so normalize when constructing the edit target
(`leads/page.tsx:350-356`): one line, one call site, no new prop, no third variant
when an international number eventually appears. Also fix `LeadEditDialog`'s
"10-digit mobile number" description (`LeadEditDialog.tsx:106`), which contradicts
a field that can hold 12.

### Defect 2 — `formatPhone` renders API-created numbers raw (cosmetic)

```
formatPhone('9876543210')    -> '98765 43210'      seed data — looks right
formatPhone('919876543210')  -> '919876543210'     API-created — raw
formatPhone('+919876543210') -> '+91 98765 43210'  the only handled shape
```

The `+91` branch requires a literal `+` (`phone.ts:27-39`). Seed and production
data differ in shape, which is why this went unnoticed.

**Fix:** handle the no-plus `91XXXXXXXXXX` case. Do **not** route `telUrl` through
`normalizePhoneDigits` — verified it throws on unparseable input, which would crash
`PhoneNumber`'s render on a malformed row. `telUrl` keeps its tolerant strip.

### Defect 3 — `MANAGER` can edit a `CUSTOMER` account (authorization gap)

`update()` gates only on `outranks` (`users.service.ts:588-591`).
`RANK.CUSTOMER = 1`, `RANK.MANAGER = 2` (`roles.ts:19-31`), so
`outranks('MANAGER','CUSTOMER') === true`. `roles.ts:27-29` states "MANAGER may
never touch a CUSTOMER row" — enforced on create and role change, **not** on
update. The writable fields include `email`, the login identifier.

**Fix in this change** (guard above `outranks`, plus a test).

### Defect 4 — `update()` has no tenant filter on the target read

`findUnique({ where: { id: targetUserId } })` (`users.service.ts:573`) — no
`organizationId`, and `User` carries no RLS. `changeRole` (`:456`) and
`assignManager` (`:963`) share the hole. A **per-org** unique phone makes it
worse: a cross-tenant caller could force a 409 inside the victim org.

**Fix `update()` here**; the other two are a follow-up item, written down.

---

## Design

### Storage format

Normalized digits-only (`919876543210`), the shape `normalizePhoneDigits` produces.
Correction to rev 1–2 wording: digits without `+` are **not** E.164. The column is
a normalized digit string; `+` is added at dial time.

Known divergence: the seed writes raw 10-digit values (`seed.ts:676-739`), so
`User.phone` may hold two shapes. Defect 2 makes both render correctly; a data
pass is unnecessary while no user rows carry a phone.

### Uniqueness — partial, per-org, staff-only, active-only

```sql
CREATE UNIQUE INDEX "User_phone_organizationId_key"
  ON "User" ("phone", "organizationId")
  WHERE "phone" IS NOT NULL AND "deletedAt" IS NULL;
```

- `phone IS NOT NULL` — a plain unique index tolerates NULLs but not `''`, and the
  `?? ''` idiom already exists at `lead/page.tsx:353`.
- `deletedAt IS NULL` — `remove()` only stamps the column
  (`users.service.ts:736-739`), so without it a leaver holds their number forever
  and a rehire can never receive it.
- Staff only — customers have no `User.phone`, so the D2 joint-buyer case cannot
  collide.

`CREATE UNIQUE INDEX` takes a blocking `SHARE` lock and cannot be `CONCURRENTLY`
inside Prisma's migration transaction. Fine at this table size; recorded so nobody
assumes otherwise.

### Migration workflow — hand-authored, NOT `--create-only`

Revision 4 of this plan proposed `prisma migrate dev --create-only` followed by
editing the generated file. **That does not work**, and the error would be silent:

- `--create-only` is driven by a **schema change**. `User.phone` already exists
  (since `20260831085813_init`), so there is no delta to generate. Prisma reports
  "Already in sync, no schema change or pending migration was found" and writes
  **no file** — leaving the next step (edit the file) impossible.
- `prisma migrate new` does not exist in Prisma 7.10.0. Verified via
  `pnpm exec prisma migrate --help`: the only commands are `dev`, `reset`,
  `deploy`, `status`, `resolve`, `diff`.
- `migrate diff --from-migrations … --to-schema … --script` (the procedure in
  `docs/planning/T-WA-VISIT-REPLY.md:74-79`) is also schema-driven and emits an
  empty script for this index.

**Correct procedure — the same one this repo already uses for its other partial
indexes.** Create the migration directory and file by hand:

```bash
cd packages/database
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_user_phone_partial_unique
# write migration.sql directly, with a header explaining the hand-authoring
```

Then verify and apply:

1. Write `migration.sql` containing only the `CREATE UNIQUE INDEX … WHERE …`
   statement plus a comment saying Prisma cannot express partial indexes.
2. **Drift check (needs a live DB):**
   `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`
   must print an **empty** script — proving schema and migrations otherwise agree,
   so this migration is the only intentional divergence.
3. `pnpm db:migrate` applies it.
4. Verify with `\d "User"` that the index exists **with its predicate** — an index
   without `WHERE` would be a different, wrong constraint.

Precedent, both hand-authored and both still live: `one_owner_per_org`
(`20260911170000_t_org_multitenancy/migration.sql:262-267`, whose header literally
says "hand-authored - Prisma can't express backfill/partial indexes") and
`SiteVisit_one_open_per_lead` (`20261009040000:137-140`). `DECISION-CHANGELOG.md:677`
records the same limitation for `one_super_admin_only`: "Prisma cannot express
partial indexes; native SQL only". The new migration carries the comment those
older ones lack.

Step 2 is the one that cannot run in this worktree — both Postgres ports refuse, so
`migrate diff` fails with `P1001`. It must be run wherever the DB is reachable, and
it belongs in the pre-apply checklist rather than in someone's head.

### P2002 attribution (verified against the installed runtime)

`rethrowAsEmailConflict`'s comment asserts email is the ONLY unique constraint on
`User`. A second index invalidates that, so a duplicate phone would report
`EMAIL_ALREADY_EXISTS`.

Verified in `@prisma/adapter-pg@7.10.0 dist/index.mjs:438-441`, SQLSTATE 23505:
`constraint = { index: error.constraint }` — an **object**, not a string. Verified
in `@prisma/client@7.10.0 runtime/client.mjs` (`Le`, ~offset 67163):
`meta = { driverAdapterError: e }`. `meta.target` does not exist in this runtime.
`meta.modelName` is `'User'` for both indexes, so it cannot disambiguate.

```ts
const index = err.meta?.driverAdapterError?.cause?.constraint?.index;
if (index === 'User_phone_organizationId_key') -> PHONE_ALREADY_EXISTS
if (index === 'User_email_organizationId_key') -> EMAIL_ALREADY_EXISTS
otherwise -> generic 409 (never mis-attribute, never swallow)
```

The generic branch matters: an unrecognized P2002 must not become "email already
exists".

### Data flow

```
  ADMIN create / edit                 SELF edit (staff only)
  POST /api/users                     PATCH /api/users/me
  PATCH /api/users/:id                (target = JWT sub)
        │                                    │
        │ target read org-scoped            │ CUSTOMER → 400
        │ (Defect 4)                        │
        ▼                                    ▼
  CreateUserDtoSchema                 UpdateProfileDtoSchema
  UpdateUserDtoSchema                 { name?, phone?: | null }
  phone?: PhoneSchema | null
        └──────────────┬────────────────────┘
                       ▼
              normalizePhoneDigits()   (null bypasses it)
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
   User.phone     AuditLog row       P2002 → constraint.index →
   (partial        (before/after,    PHONE_ALREADY_EXISTS |
    unique)         same tx)         EMAIL_ALREADY_EXISTS | generic
                       │
                       ▼
        GET /api/users (includePhone)   GET /api/users/:id
                       │                        │
                       │                        ├─ staff: User.phone
                       │                        └─ CUSTOMER: derived (admin only)
                       ▼
              formatPhone() / telUrl()   (fixed)
```

Shadow paths:

| Path                              | Behaviour                                               |
| --------------------------------- | ------------------------------------------------------- |
| nil on update                     | column untouched                                        |
| `null`                            | **clears the number** — a PII field needs an erase path |
| `''`                              | 400, field-named message                                |
| unparseable                       | 400                                                     |
| duplicate, same org, active staff | 409 `PHONE_ALREADY_EXISTS`                              |
| duplicate, other org              | allowed                                                 |
| phone on a `CUSTOMER`             | 400 with the reason                                     |
| cross-org target id               | 403 (Defect 4)                                          |

**Erase path — verified, not assumed.** `PhoneSchema` is a `superRefine` +
`transform`. I ran the shape against the installed Zod:

```
z.union([PhoneSchema, z.null()]).optional()
  '9876543210' -> '919876543210'  ✅ normalized
  null         -> null            ✅ clears
  undefined    -> undefined       ✅ omitted
  ''           -> REJECTED        ✅ no silent no-op
```

All four pass in `packages/api-types` (probe run, then removed). Without the union,
a set number would be permanent.

**`UpdateProfileDtoSchema.name` becomes optional.** Today `z.object({ name: nameSchema })`
(`auth.ts:255-257`) and `updateSelf` writes `data: { name: dto.name }`
unconditionally (`users.service.ts:677-681`), so a phone-only self-edit is
impossible without resending the name.

### The picker leak — closed with an opt-in flag

`useUsers` → `GET /api/users` → `UserListResult.rows` is the payload for **six**
consumers beyond the admin table: `LeadReassignDialog:132`, `LeadCoOwnerDialog:100`,
`AddTeamMembersDialog:46`, `team-form-bodies.tsx:67`, `AssignedEngineerRow.tsx:29`,
`leads/new/page.tsx:221`.

**Resolution:** `UserFilterDto` gains `includePhone?: boolean`, mirroring the
existing `availableOnly`. `list()` selects `phone` only when true; the admin page
passes `true`, pickers pass nothing. `CreatedUser` (returned by `create`,
`changeRole`, `assignManager`, `update`, and `teamMembers` — the @mention roster of
up to 200 rows) is **not** touched at all.

Default-false is deliberate: a future picker that forgets the flag leaks nothing.

### CUSTOMER rows in the admin users table

ADMIN/OWNER lists include CUSTOMERs, who have no `User.phone`. Blank would be the
silent-failure shape this repo keeps fixing.

**Resolution:** when `includePhone` is set, batch-read the leads for the CUSTOMER
rows on the page and show the derived number, labelled as lead-sourced. Same
batched shape the page already uses for `ledTeams` (`users.service.ts:~1500`), so
paging cost is unchanged. A missing lead renders `—`.

### User detail

- **Staff target:** `User.phone` from `UserDetail`.
- **CUSTOMER target:** derived via the lead — works for ADMIN/OWNER
  (`lead_select_admin`, `policies.sql:108`). MANAGER already 403s on customers
  (`users.service.ts:829-835`).

No CUSTOMER self-read path. The `PortalMeDto` idea from rev 3 is **dropped**: the
portal never reads `Lead` and has no CUSTOMER Lead policy, so it would need a new
SECURITY DEFINER helper plus a policy — real RLS surgery for a number the portal
has never shown.

### Search

Adding `phone` to the `list()` search `OR` searches a digits-only column with
`contains`, so `98765 43210` and `+91 98765 43210` would both miss. Normalize the
term through `normalizePhoneDigits` (try/catch → raw fallback) before the `OR`.

### Authorization summary

No new endpoint. Writes stay inside existing `withRlsContext()` transactions. Two
guards added: org-scope the `update()` target read (Defect 4), and reject
`CUSTOMER` targets in `update()` (Defect 3). `UpdateProfileDto` rejects `phone` for
`CUSTOMER`, so self-service cannot create a second copy.

### Surfaces

| Surface          | File                                      | Change                                          |
| ---------------- | ----------------------------------------- | ----------------------------------------------- |
| Create user      | `CreateUserForm.tsx`                      | phone field, staff roles only                   |
| Edit user        | `admin/users/page.tsx` (`EditUserDialog`) | phone field, staff targets                      |
| Users table      | `admin/users/page.tsx`                    | Phone column after Email; customer rows derived |
| Users search     | `users.service.ts` `list()`               | normalized phone term in `OR`                   |
| User detail      | `UserDetailView.tsx`                      | phone row; customer rows lead-labelled          |
| Settings (staff) | `settings/page.tsx`                       | editable phone via `useUser(self)`              |
| Hooks            | `hooks/queries/users.ts`                  | `phone` on detail + opt-in list + inputs        |

Not touched: `PortalMeDto`, portal UI, RLS policies, better-auth config.

### Audit

`user.create` / `user.update` / `user.updateSelf` add `phone` to `after` (and
`before` on update). Audit rows are long-lived snapshots, so a phone lands in
history permanently — consistent with `email`. Retention/erasure for audit PII is a
compliance question this plan raises and does not answer; flagged for the owner.

---

## Test plan

| Level      | Test                                                                                       | File                                             |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Unit       | `normalizePhoneDigits` shapes                                                              | `packages/api-types/test`                        |
| Unit       | clearable-union contract: phone / `null` / omitted / `''` rejected                         | `packages/api-types/test`                        |
| Unit       | `formatPhone` no-plus `91…`; `telUrl` returns `''`, never throws                           | `lib/phone.test.ts`                              |
| Component  | **Defect 1**: 12-digit stored value → edit target shows 10 → round-trip preserves DB value | `LeadEditDialog.test.tsx`                        |
| Service    | `create()` persists normalized; nil stays null                                             | `users.service.test.ts`                          |
| Service    | `update()` writes and **clears** (`null`)                                                  | `users.service.test.ts`                          |
| Service    | `updateSelf()` writes for staff; rejects for CUSTOMER                                      | `users.service.test.ts`                          |
| Service    | `includePhone` false → no phone key in rows                                                | `users.service.test.ts`                          |
| Service    | **Defect 3**: MANAGER cannot update a CUSTOMER                                             | `users.service.test.ts`                          |
| **DB**     | P2002 phone vs email attribution, real round-trip                                          | `users.service.rls.test.ts`                      |
| **DB**     | soft-deleted phone reusable; cross-org duplicate allowed                                   | `users.service.rls.test.ts`                      |
| **DB**     | **Defect 4**: cross-org target id refused                                                  | `users.service.rls.test.ts`                      |
| Controller | malformed phone → 400 via `parseBody`, not 500                                             | `users.controller.test.ts`                       |
| Component  | staff forms submit phone; field absent for CUSTOMER                                        | `CreateUserForm.test.tsx`, `users/page.test.tsx` |
| Component  | settings saves + clears phone                                                              | `settings/page.test.tsx`                         |

The three DB-backed tests sit in `users.service.rls.test.ts` on purpose: the mocked
suite hand-rolls `PrismaClientKnownRequestError`
(`users.service.customer.test.ts:21`), so a fake error would only prove the parser
matches its own assumption — the exact mistake revision 2 made.

## Verification log

Claims I checked directly rather than trusted:

| Claim                                               | Method                                           | Result        |
| --------------------------------------------------- | ------------------------------------------------ | ------------- |
| `PhoneNumberInput` corrupts on one keystroke        | replicated `digitsOnly` + `normalizePhoneDigits` | confirmed     |
| `z.union([PhoneSchema, z.null()]).optional()` works | ran vitest probe                                 | 4/4 pass      |
| `constraint` is an object                           | read `adapter-pg@7.10.0 dist/index.mjs:438-441`  | confirmed     |
| `meta.target` absent in Prisma 7.10                 | grepped the client runtime                       | 0 occurrences |
| `Lead` has no CUSTOMER SELECT policy                | read `policies.sql:78-1301`                      | confirmed     |
| Portal never reads `Lead`                           | grepped `customer-portal.service.ts`             | confirmed     |
| No CUSTOMER settings page                           | read `portal-routing.ts:84-88`                   | confirmed     |
| Six pickers read `UserListResult`                   | grepped `useUsers`                               | confirmed     |
| Defect 3 (MANAGER → CUSTOMER)                       | read `roles.ts:19-31` + `update()` gates         | confirmed     |
| No org filter on `update()` target                  | read `users.service.ts:573`                      | confirmed     |

Not verified: whether any `User` row already holds a phone. Both Postgres ports
refused in this worktree (6432 and 5432). The index creation fails loudly on
duplicates rather than dropping data, so this is safe to discover at apply time —
but confirm before applying.

Codex's final pass returned after ~8.4 minutes (it hit the 600s timeout at the
very end, so the output was truncated to the tail of its reasoning). Its one
substantive finding was correct and is now fixed in revision 5: the
`--create-only` migration step would have silently produced **no file**, because
that flag is schema-change driven and `User.phone` already exists. Its other
checks confirmed rather than changed the plan — the adapter error shape, the
`meta.target` absence, the index-name length, and the fact that a Prisma-unknown
partial index still surfaces P2002 normally.

Cross-model agreement therefore rests on two Claude subagent passes plus one
partially-truncated Codex pass.

## Not in scope

- **Customer-facing phone display** (portal). Needs `PortalMeDto` + a new SECURITY
  DEFINER helper + a CUSTOMER Lead policy. Logged in TODOS.md.
- **FreJun provisioning script.** Unbuilt; blocked on vendor sign-off (Input #4)
  and the numbers this collects.
- **OTP / phone sign-in / verification.** D1 rejected auth use. Note both voices'
  distinction: "not an auth factor" ≠ "never verified". Logged.
- **Provider-agnostic telephony agent model** (agent ID, DID, KYC state). Right
  long-term shape, wrong to build before the vendor contract exists.
- **Repair of leads already corrupted by Defect 1.** Needs an audit query plus a
  data decision. Deferred; the fix stops new damage.
- **Normalizing `Lead.phone`.** Separate, riskier migration touching lead identity.
- **Org-scoping `changeRole()` / `assignManager()`** (Defect 4's siblings).
- **Audit-log PII retention/erasure policy.** Compliance, flagged.

## Why the customer copy was dropped

1. **It breaks a shipped invariant.** D2 requires two logins per lead
   (`SPEC-customer-progress-slice-2.md:87`, `customer-portal-rls.test.ts:250`). A
   copied phone plus per-org uniqueness makes the second login fail with 409.
2. **No good sync rule exists.** The lead phone is the WhatsApp identity key, and
   `docs/designs/lead-fact-ledger.md` forbids other surfaces writing it. A frozen
   copy diverges on the first number change; a live copy would write lead identity
   from the account, which that document rules out.
3. **It duplicates an existing fact.** `customerLeadId` is already the join.

## Rollback posture

App code reverts independently of the index. No destructive migration, no rewrite,
no backfill. `DROP INDEX` removes the constraint; collected data survives a revert.
The three new guards fail closed, so an old client keeps working.
