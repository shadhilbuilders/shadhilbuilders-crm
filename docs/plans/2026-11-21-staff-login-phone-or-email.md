# Staff login by phone or email, and optional email at invite

Status: revised after an outside review and a design review. Every finding was checked against the code before being accepted. Awaiting build approval.

Design review: 4/10 before, 8/10 after, all seven passes run. See the completion summary at the end.

## Goal

An admin can invite a staff member without an email address. That person signs in with their phone number and password. Anyone who does have an email can still sign in with it. Nothing about password storage, session issuance or the accept-invite flow changes.

## Non-goals

- No better-auth `phoneNumber` plugin, no OTP, no SMS. The phone is a lookup key, not a credential.
- No schema change to `User.email`. It stays `NOT NULL` because better-auth requires it.
- No self-service change from one real email to another. That stays admin-only (Decision 4).
- No redesign of the login page, the invite dialog, Settings or the users table. The layout, card, button and spacing conventions stay exactly as they are; only the additions below appear.

## Decisions

1. Placeholder email is random and non-routable: `noemail+<16 hex>@users.invalid`. Not derived from name or phone. `User.email` is unique only per org (`schema.prisma:424`) while sign-in looks a user up by email alone (`schema.prisma:313-322`), so an address that repeats across orgs makes `signIn.email` pick an arbitrary row. Random also removes rehire squatting (the unique index includes soft-deleted rows) and phone-correction staleness.
2. No duplicate-phone guards on invites and no phone uniqueness change. `Invite.phone` is documented as deliberately non-unique: two staff may share a site phone (`schema.prisma:574`). Phone login resolves by account, never by assuming one account per number.
3. The organisation picker appears only after the submitted password has matched more than one account. An unauthenticated resolver that listed organisations for a number would leak who works where to anyone holding it.
4. Real-to-real email changes stay admin-only. Settings states this today (`settings/page.tsx:352`) and `PATCH /api/users/me` excludes `email` for the same reason (`api-types/src/auth.ts:328`): there is no email verification, so a self-service change moves the login to an address nobody has proven they own. Placeholder-to-real is the one narrow exception.
5. `PATCH /api/users/:id` already accepts `email` (`api-types/src/auth.ts:312`), so the admin path is not new work. The hierarchy hole from `docs/designs/2026-11-18-user-phone.md` Defect 3 was closed on 2026-11-18: `users.service.update()` refuses a non-admin editing a CUSTOMER outright (`users.service.ts:714-720`), with a regression test at `users.service.test.ts:1539`. Verified while planning this work, not assumed; nothing to add.
6. Invite expiry is persisted lazily, not swept. `create()` flips any past-deadline PENDING row for that address to EXPIRED inside its own transaction, immediately before inserting, because that is the only moment the stored value blocks anything. Reads keep deriving, the EXPIRED list filter accepts both shapes, and ACCEPTED or REVOKED rows are terminal and never flipped.

## What the user sees

Every surface below is an Operate surface: the person is completing a task, so the design work is orientation and state, not expression. Screens are described in the order a person meets them.

### 1. Login (`apps/web/src/app/(guest)/login/LoginForm.tsx`)

One card, `max-w-sm`, centred, exactly as today. Inside it the first field changes meaning; nothing else moves.

```
+------------------------------------------+
|            Shadhil CRM                   |
|        Sign in to your account            |
|                                          |
|  Email or phone                          |
|  [ you@shadhilbuilders.in or 98765 43210 ]|
|                                          |
|  Password                                |
|  [ .......................  (eye) ]       |
|                                          |
|  [              Sign in                ]  |
|                                          |
|  Shadhil Builders internal system -       |
|  access is provisioned by an admin.       |
+------------------------------------------+
```

- Label `Email or phone`, placeholder `you@shadhilbuilders.in or 98765 43210`, and `inputProps: { autoComplete: 'username', inputMode: 'text', autoFocus: true }`. The rich autocomplete token has to sit in `inputProps`: the field's own `autoComplete` accepts only `'on' | 'off'`. `inputMode="text"` rather than `email`, because the browser's email keyboard hides digits on mobile.
- Password field unchanged (`PasswordInput`, `autoComplete="current-password"`, `data-qa="login-password"`).
- Submit reads `Sign in`, then `Signing in...` while pending; both fields disabled, no overlay spinner. Same pattern as today.
- One failure string for every outcome, as a toast: `Invalid email, phone or password.` Shape errors stay inline under the field via zod (`Enter your email or phone number`). The existing account-enumeration defence is preserved: the field judges shape only.

### 2. Account picker (new, same card, replaces the form)

Rendered only when the resolver answers `kind: 'pick'`. Same `Card`, same width, no dialog.

```
+------------------------------------------+
|         Which account?                   |
|  This number is linked to more than one   |
|  account. Choose the one to sign in to.   |
|                                          |
|  ( ) Ravi Kumar                          |
|      Shadhil Builders                    |
|  ( ) Ravi Kumar                          |
|      Demo Constructions                  |
|                                          |
|  [              Continue               ]  |
|  Back                                     |
+------------------------------------------+
```

- Person name is the primary line, organisation the secondary muted line. Two accounts in the same organisation can legitimately share a phone (Decision 2), so the org alone is not enough to tell them apart. When two rows resolve to the same organisation, both rows append the person's role as a third part (`Ravi Kumar / Shadhil Builders / Telecaller`); the role is already in the resolver payload's User row and is how an operator talks about these people.
- Options are real radio inputs inside `role="radiogroup"` with `aria-label="Choose an account"`, one 44px minimum row each, visible labels. Focus moves to the first option on render.
- The list caps at about six visible rows with the body scrolling, because the resolver allows up to 10 candidates and ten two-line rows is taller than a 640px phone viewport.
- `Continue` is disabled until a choice is made. `Back` is a ghost button that returns to the form with the identifier kept and the password cleared, because the password was already spent and re-typing it is the honest cost of changing your mind.
- No account is pre-selected. Pre-selecting the first row turns a mis-tap into a wrong-organisation login.

### 3. Invite dialog (`InviteStaffDialog.tsx`)

The email field collapses behind a disclosure. Everything else in the dialog is untouched.

```
+------------------------------------------+
|  Invite staff member                     |
|  Name      [ ..................... ]     |
|  Phone     [ ..................... ]     |
|  Role      [ TELECALLER        v ]       |
|                                          |
|  > Add an email (optional)               |
|                                          |
|  [ Cancel ]            [ Send invite ]   |
+------------------------------------------+
```

- Collapsed trigger row: `Add an email (optional)` with a chevron, `data-qa="invite-email-toggle"`, `aria-expanded`, `aria-controls` pointing at the panel.
- Expanded: the existing email input plus helper text `Used for signing in and notifications. Leave it empty and the person signs in with their phone number.`
- Once an address is typed the trigger reads `Email: name@example.com`, stays expanded, and typing is never lost by collapsing. Changing your mind clears it back to the collapsed label.
- Blank means "no email", and the DTO must say so. `EmailSchema.optional()` rejects `''`, so a blank input would 400 as if the address were invalid. The project convention in the `paalstack-react-ui` skill is the union: `z.union([z.literal(''), EmailSchema]).optional()`, with the service normalising `''` to absent before it reaches Prisma. Also add the regression tests the same skill names: `parse({ email: '' })` succeeds and `parse({ email: 'not-an-email' })` still throws.
- The result step is untouched. It already shows only the invite URL (`CopyableLink`), the WhatsApp send on `result.invite.phone`, and the seven-day expiry note, so it never renders an email and needs no new state. Only the form step gains the disclosure.

### 4. Settings, profile block (`settings/page.tsx`)

Two states, decided by whether the stored address is a placeholder.

```
Placeholder account                     Normal account
+-----------------------------+         +-----------------------------+
| Email                       |         | Email                       |
| [                    ]      |         | [ ravi@shadhilbuilders.in ] |
| Add an email so you can     |         | (i) Email changes need an   |
| also sign in with it.       |         | administrator ...           |
| Until then use your phone.  |         +-----------------------------+
|                             |
| Current password            |
| [ ................. ]       |
|                             |
| [  Add email  ]             |
+-----------------------------+
```

- The current-password field appears only once the email field is dirty, and the button is disabled until both are filled. Asking for a password before the person has typed anything is a cost with no purpose.
- Success: toast `Email saved. You can now sign in with either.` and the block switches to the read-only state.
- Duplicate address: inline under the field, `That email is already used in this organisation.` Wrong password: inline under the password field, `That password is not correct.` Both are field errors, not toasts, because both are fixable in place.
- The existing read-only state and its administrator note stay exactly as they are for real addresses.

### 5. Admin users table (`admin/users/page.tsx`)

The table already has a Phone column with a `phoneSource` distinction, so the email cell must not repeat the phone. Rules per row:

| Stored email | Email cell | Phone cell |
| --- | --- | --- |
| real address | the address, as today | as today |
| placeholder, phone present | muted `No email` plus a tooltip `This account signs in with its phone number.` | as today |
| placeholder, no phone | muted `No email` plus the same tooltip | existing empty dash |

Search gains phone, and that means both halves: the accessor becomes `['name', 'email', 'phone']` and the placeholder reads `Search by name, email or phone...` (`page.tsx:777`), and the backend list query must match phone too. The table's search is server-side (`onSearchValueChange` drives the API), so changing only the client accessor would move the placeholder text and change nothing about the results.

The users table is the one place where the phone is *not* substituted for the email, precisely because it already has its own column.

### 6. Accept invite (`(guest)/invite/[token]/AcceptInviteForm.tsx`)

Today it prints `preview.email` (`:200`) and signs in with it (`:103-104`). For a placeholder invite the header shows the phone instead: `Signing in as 98765 43210`. The synthetic address is never rendered to the person it belongs to.

## Interaction states

| Feature | Loading | Empty | Error | Success | Partial |
| --- | --- | --- | --- | --- | --- |
| Login submit | button `Signing in...`, both fields disabled | fields empty, submit enabled, no inline errors until submit | toast `Invalid email, phone or password.`; fields re-enabled; password left as typed | redirect by document navigation, as today | not applicable |
| Account picker | `Continue` disabled until a row is chosen | never rendered with zero rows; a zero-match resolver returns the generic failure instead | picker POST failing on the second submit returns to the picker with the toast and the previous choice kept | pick one, `Continue`, redirect | `More than 10 accounts match` is not a state: over-cap returns the generic failure and logs a warning |
| Invite dialog email | n/a | collapsed trigger row is the empty state | inline zod error under the field; empty is not an error | trigger reads `Email: address`, no toast | an invite without an email shows a muted `No email` chip in the pending list |
| Settings email | `Add email` shows `Saving...` | field empty with helper text | inline under field (duplicate) or under password (wrong password) | field switches to read-only, toast confirms | n/a |
| Users table email cell | n/a | `No email` with tooltip | n/a | n/a | n/a |

## Journey

| Step | User does | User feels | Plan specifies |
| --- | --- | --- | --- |
| 1 | Opens the login page | Routine, no surprises | Same card, same heading; only the first label changed |
| 2 | Types `98765 43210` and their password | Slight uncertainty: "does this really work with a number?" | Placeholder shows both forms, so the field says yes before they try |
| 3a | Submits, one account matches | Relief, then they are in | No extra step; straight redirect |
| 3b | Submits, two accounts match | Brief "oh, right, two orgs" | Picker names the person and both orgs, with a way back |
| 4 | Wrong password | Mild annoyance, no shame | One neutral sentence, password kept so they can fix a typo |
| 5 | Later opens Settings and sees "Add an email" | Understood as optional, not a chore assigned | Helper text names the benefit, current-password only appears once they start |
| 6 | Admin invites the next person without an email | Faster than before | The disclosure is collapsed by default, so the dialog is shorter, not longer |

## Design system alignment

Everything reuses `@paalstack/react-ui` 1.7.2 through its Props API. No new primitives, and no hand-rolled controls where the library already has one.

| Need | Component / helper | Source |
| --- | --- | --- |
| Login form, labels, inline errors, submit states | `<Form fields={...} />`, props API only | existing `LoginForm.tsx` |
| Password entry and reveal | `<PasswordInput>` | `components/shared/PasswordInput.tsx` |
| Account picker | `<RadioGroup options={...}>` (props API takes `options`, not children) | library, verified export |
| Status chip for a pending invite with no email | `<Badge variant="secondary">No email</Badge>`, never a hand-rolled span | library |
| Card, heading, muted text | `Card`, `Heading`, `TypographyP` | already imported by the login page |
| Invite dialog shell | existing `Dialog`, footer carries the submit | unchanged |
| Phone display | `formatPhone`, `telUrl` | `apps/web/src/lib/phone.ts` (both defects from the 2026-11-18 doc are already fixed) |
| Email-or-phone decision | `isPlaceholderEmail` in `api-types`, `displayIdentifier` in `apps/web/src/lib/identity.ts` | new |

Library conventions that constrain the implementer, from the `paalstack-react-ui` skill:

- The `<Form>` field shape does not run per-field validation beyond the HTML `required` attribute. Rich HTML autocomplete tokens belong in `inputProps`, not the field's own `autoComplete` (which only accepts `'on' | 'off'`). `maxLength` belongs in `inputProps` / `textareaProps`.
- `<Form>` renders a real `<form>` and defaults to `method="post"`, which is what keeps a pre-hydration submit from putting a password in the URL. Do not pass `method="get"`.
- Every element gets a `data-qa`, and interactive ones also carry `focus-visible:ring-2`. Semantic tokens only, no raw colours.
- A zod schema change in this repo requires loading the `zod` skill first. Use the top-level `z.email()`, never `z.string().email()`.
- `@testing-library/react` is not installed in `apps/web`. Non-portal components are asserted with `renderToStaticMarkup`; anything whose render depends on an effect is mounted with `createRoot` + `act`.

## Responsive and accessibility

- 360px: the login card is already `max-w-sm` inside the page padding; the picker rows are full width with a 44px minimum height, so the two-line option (name + org) wraps without truncation. At 360px the invite dialog and Settings single-column layout are already in place (`grid gap-4 sm:grid-cols-2`).
- Keyboard: Tab reaches label, field, password, submit in that order. On the picker, arrow keys move within the radiogroup, `Enter` activates `Continue`, `Escape` goes back. Focus moves into the group when it renders; no focus trap.
- Screen readers: the field keeps a real `<label>` element (never placeholder-as-label). The picker announces `2 accounts found` through a polite live region, then the radiogroup. Field errors stay associated via the Form's error wiring.
- Contrast and targets: secondary text uses `--muted-foreground`, pinned at oklch 0.525 in `packages/ui-tokens/src/brand.css` and audited pair by pair in `packages/ui-tokens/test/compliance.test.ts` (`SHADHIL_AA_OVERRIDES`, lines 221 and 228). `brand.css` records 7.71:1 on the dark page and 5.71:1 on a dark card after the 2026-11-08 fix. Interactive targets are `min-h-11` (44px), matching the current login and settings fields.

## Phase 0: shared primitives

- `packages/api-types/src/common.ts`: `PLACEHOLDER_EMAIL_DOMAIN = 'users.invalid'` and `isPlaceholderEmail(email)`. The formatting helper does not live here: `apps/web/src/lib/identity.ts` gets `displayIdentifier({ email, phone })`, because it needs `formatPhone` from the web app and `api-types` stays a contract package with no presentation logic.
- `packages/api-types/src/invites.ts`: `CreateInviteDtoSchema.email` becomes `EmailSchema.optional()`.
- `packages/api-types/src/auth.ts`: `UpdateProfileDtoSchema` gains `email` (EmailSchema, optional) and `currentPassword` (optional), with a refine that requires `currentPassword` whenever `email` is present.
- Phone input on the login path normalises with the existing `normalizePhoneDigits` (`common.ts:72`), which produces `91XXXXXXXXXX`. Stripping to digits by hand breaks plain 10-digit input.

## Phase 1: invite without an email

- `apps/backend/src/invites/invites.service.ts` `create()`: compute `const email = dto.email ?? makePlaceholderEmail()`. Run the existing duplicate checks against that computed value, never against `dto.email` (a Prisma `where: { email: undefined }` silently drops the predicate and matches an arbitrary row). `makePlaceholderEmail()` lives next to the invite token helpers and uses `crypto.randomBytes(8)`.
- Accept path unchanged: it already pins `email: invite.email`, and a random address is unique by construction.
- `InviteStaffDialog.tsx`: the disclosure described above, with the key omitted when blank.
- Display: `displayIdentifier` on the invite rows, the app shell footer, the Settings footer and the accept page. The users table follows the rules in its own section above.

## Phase 2: login by phone

Backend. The resolver is a method on the existing `UsersService`, not a new service class (eng review D1): the credential helpers, user lookups and audit access it needs all live there. One new controller file is the only new entry point on the backend.

`POST /api/public/auth/login-identifier`, a `@Public()` route following the pattern in `invites-public.controller.ts:77` (the public decorator exists at `apps/backend/src/auth/public.decorator.ts`; `AGENTS.md` allows `@Public()` where the credential is presented in the call itself, which a password is):

- Body `{ identifier, password, organizationSlug? }`. Response always 200 with one of `{ kind: 'ok', email }`, `{ kind: 'pick', accounts: [{ name, organizationName, organizationSlug, role }] }`, `{ kind: 'invalid' }`. No 401/404 split, no hint about whether the account exists.
- Candidates: `deletedAt: null`, `banned: false`, `phone = normalizePhoneDigits(identifier)`, cap **5** (eng review D3). The query is served by the existing partial index `User_phone_organizationId_key` on `("phone", "organizationId")` where `phone IS NOT NULL AND deletedAt IS NULL` (`20261118120000_user_phone_partial_unique/migration.sql:52`), so no new index is needed.
- Password check: `verifyPasswordAsync` in `apps/backend/src/users/credentials.ts`. The async version becomes the primitive and the existing sync `verifyPassword` delegates to a shared parse helper, so the two cannot drift on the `salt:key` format or the scrypt parameters. One test proves both accept the same stored hash. `scryptSync` blocks the event loop (`credentials.ts:56`) and this route is unauthenticated.
- Always perform at least one comparison against a fixed dummy hash, so a zero-candidate request costs the same as a one-candidate one.
- Concurrency: cap in-flight verifications at 2 with a small semaphore. The scrypt calls run on the libuv threadpool (four threads by default), so per-IP throttling alone does not stop many IPs from saturating it.
- Rate limit: `@nestjs/throttler`, added as a backend dependency, applied to this route at 10 requests per minute per IP (eng review D2). better-auth's limiter only covers `/api/auth/*`. Reject passwords longer than 128 characters before hashing.
- Organisation names for the picker: new migration with a `SECURITY DEFINER` helper `auth_account_identities(user_ids text[], phone text)` returning `(user_id, org_name, org_slug)` for users whose stored phone equals the argument, `search_path` pinned, `EXECUTE` granted to `shadhil_app` only. Passing the phone as well as the ids means the helper cannot be turned into an organisation lookup for arbitrary user ids. `Organization` is RLS-scoped to `app.user_org_id` (`rls/policies.sql:50`), so a plain read returns nothing for other orgs. Same pattern as `team_member_exists` and `progress_photo_creator_label`; helpers ship through migrations, so this deploys with the app.
- The resolver returns the matched account's email and the client then calls the existing `signIn.email` (eng review D4). That keeps the session mechanics on the path that already works. Consequence to accept: whoever holds a shared phone and its shared password learns that account's login address, which for a shared site phone is a colleague's email.

Web:

- `apps/web/src/app/api/public/auth/login-identifier/route.ts`, a route handler that forwards to the backend and passes the client IP through. Add `/api/public/auth` to `PUBLIC_PATHS` in `apps/web/src/proxy.ts`; today only `/invite` and `/api/public/invites` are public.
- `LoginForm.tsx` renders the picker as its own state rather than a separate component (eng review D1), and implements the screen specifications under "What the user sees".

## Phase 3: email change, narrow

- `PATCH /api/users/me` accepts `email` only when the stored address `isPlaceholderEmail`. Requires `currentPassword`, validates with EmailSchema, maps a P2002 to the existing friendly 409, sets `emailVerified: false`, writes an audit row, and refetches the session so the shell and settings stop rendering the old value.
- `PATCH /api/users/:id` already accepts `email`, and the MANAGER-to-CUSTOMER guard is already in place (`users.service.ts:714-720`), so that path needs no change.
- Block clearing `phone` while the email is a placeholder, in `users.service.updateMe`. Otherwise the account has no usable login identifier and the synthetic address is invisible to its owner.
- Settings: the two states above.

## Phase 4: invite expiry semantics

Invite expiry is derived everywhere, and one place needs it stored.

The bug, verified: `create()` allows a re-invite when the existing invite is past its deadline (`apps/backend/src/invites/invites.service.ts:235-249` checks `status: 'PENDING'` plus `expiresAt: { gt: new Date() }`), but the uniqueness guard in the database is `Invite_one_pending_per_email ON "Invite"("organizationId", lower("email")) WHERE status = 'PENDING'` (`20261120120000_staff_invites/migration.sql:72-74`), which has no expiry clause. The request passes the application check, reaches the insert, and dies on a raw P2002. Today that needs a real email and a seven-day wait to hit; with invites by phone it becomes the ordinary path for re-hiring.

Rule: the stored status flips to `EXPIRED` the first time an admin re-invites that address. Reads stay derived, so nothing changes about what the admin sees.

- New private `expireLapsed(client, organizationId, email)` in `apps/backend/src/invites/invites.service.ts`: an `updateMany` over `{ organizationId, email, status: 'PENDING', expiresAt: { lte: now } }` setting `status: 'EXPIRED'`. At most one row can match, because the partial unique index permits only one PENDING row per org and address. It lives on the service rather than in `invites.tokens.ts` because it needs the RLS transaction's client, and that module stays pure.
- Call it inside `create()`'s existing RLS transaction, before the live-invite check. The check then reduces to `status: 'PENDING'`: after the flip, any remaining PENDING row is by definition live, and the insert cannot collide with an expired one.
- Compare on the same normalised address the index uses. `Invite.email` is stored lowercased by `EmailSchema`, so `email: dto.email` is already the exact key; do not introduce a second case-folding rule in SQL.
- Keep the partial unique index as the backstop and map its P2002 to `INVITE_ALREADY_PENDING`, so two concurrent creates produce the friendly 409 rather than a 500. One wins, the other is told to resend.
- Every derived filter must accept both shapes, or a flipped row vanishes from the list. In `packages/api-types/src/invites.ts` (the mapping documented at `:88-100`), `EXPIRED` becomes `{ OR: [{ status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }] }`. `PENDING` keeps `{ status: 'PENDING', expiresAt: { gt: now } }`. This is the one place the change can silently hide data, so it gets its own test.
- `resend()` needs no change and is the revive path: it updates the existing row in place (`invites.service.ts:368-400`), resetting `tokenHash`, `expiresAt` and `status: 'PENDING'`, so it never inserts and never touches the index. Its guards only refuse ACCEPTED and REVOKED, which is why an expired invite can be revived there.
- No migration. `InviteStatus.EXPIRED` already exists (`packages/database/prisma/schema.prisma:561`), the column is there, and the index already keys on `status`.
- Accepted stays accepted. The flip's `WHERE` requires `status: 'PENDING'`, so an invite accepted on day six and read on day eight never rewrites its own history.

Tests for this phase: re-invite after expiry succeeds and the old row reads `EXPIRED` in storage; a live invite still returns 409 `INVITE_ALREADY_PENDING`; an accepted invite past its deadline is untouched; the list's `EXPIRED` filter returns both a derived and a stored expiring row; resend on an expired invite revives it with a new deadline; two concurrent creates yield one invite and one friendly 409.

## Tests

Unit: placeholder shape and uniqueness; create without email; blank email omitted; resolver passthrough, single match, zero match, two matches sharing a password, two matches with different passwords, banned excluded, soft-deleted excluded, 10-digit and `+91` and leading-zero input, over-cap, and a spy asserting the dummy comparison runs on a zero-candidate request. No wall-clock timing assertion: a timing test fails on a loaded CI box for reasons unrelated to the code, so the spy is the honest check. One test proves `verifyPassword` and `verifyPasswordAsync` accept the same stored hash.

Database-backed, in the RLS matrix style against `shadhil_crm_test`: `auth_account_identities` returns cross-org names for the granted role, refuses rows whose phone does not match the argument, and fails for any other role.

Web component tests: login phone path, picker render, second submit and back action, dialog disclosure including the blank-payload case, Settings placeholder state and duplicate/password errors, users table cell rules (three cases), search by phone, and a test that the accept page renders no `users.invalid` text.

End to end, one Playwright case alongside the existing invite audit: sign in through the BFF route with a phone and password, land on the app, and confirm a wrong password returns the generic message.

## Rollout

Migration first, then the app deploy (`deploy-coolify.yml` already runs `prisma migrate deploy` on the API container). Verify on prod: helper exists and is granted only to `shadhil_app`, the new route answers 200 with `kind: 'invalid'` for a junk identifier, and the rate limit fires on the eleventh attempt in a minute.

## Not in scope

- Email verification. There is no mailer, so nothing to verify with. Deferred until a mailer exists; the reset path must be gated on `emailVerified` at that point.
- Full self-service real-to-real email change. Needs verification, or an explicit acceptance of the takeover path. Decision 4.
- A cron sweep of expired invites. The flip is lazy on the only path that needs the slot freed; a sweeper would only matter for reporting on stored status, and no report reads it. Decision 6.
- SMS or WhatsApp OTP login. A different project with its own security review.
- Redesigning the login page layout, the users table, or the Settings grid.

## What already exists

- `docs/designs/2026-11-18-user-phone.md` (revision 5) is the calibration document for phone storage, display, validation and the RLS constraints. Its Defects 1 and 2 are already fixed in `lib/phone.ts`; Defect 3 is still live and is now Task T2.
- The `paalstack-react-ui` skill is the authority on library APIs for this work, not general design sense: props API by default, `RadioGroup options`, `Form` field-shape limits, the dialog footer convention, `data-qa` on every interactive, semantic tokens only.
- `@paalstack/react-ui` 1.7.2: `Card`, `Form`, `Heading`, `TypographyP`, `toast`, `PasswordInput` wiring, `DataTable` with server-side search.
- `normalizePhoneDigits`, `PhoneSchema` (`api-types/src/common.ts`), `formatPhone`, `telUrl` (`lib/phone.ts`).
- The users table already has a Phone column with `phoneSource`, so no new column is needed.
- The accept-invite flow already pins the email and already has a one-page preview.

## Implementation tasks

- [X] **T1 (P1, human: ~40min / CC: ~8min)** - api-types - add `isPlaceholderEmail`, `PLACEHOLDER_EMAIL_DOMAIN`, the blank-or-email union on invite, and the profile DTO `email` + `currentPassword`
  - Surfaced by: Phase 0. Load the `zod` skill before touching any schema, per the repo rule in `paalstack-react-ui`.
  - Files: `packages/api-types/src/common.ts`, `packages/api-types/src/invites.ts`, `packages/api-types/src/auth.ts`
  - Verify: `pnpm --filter @shadhil/api-types test`, plus the blank-email and bad-email regression cases, type-check
- [X] **T2 (P1, human: ~30min / CC: ~6min)** - backend - guard MANAGER editing a CUSTOMER in `users.service.update()`, with a regression test
  - Surfaced by: Decision 5 / `2026-11-18-user-phone.md` Defect 3
  - Files: `apps/backend/src/users/users.service.ts`, its test
  - Verify: `pnpm --filter @shadhil/backend test`
- [X] **T3 (P1, human: ~1.5h / CC: ~20min)** - backend - placeholder generation and invite creation without an email
  - Surfaced by: Phase 1
  - Files: `apps/backend/src/invites/invites.service.ts`, `invites.tokens.ts`, tests
  - Verify: unit tests for placeholder shape, uniqueness, blank payload, duplicate checks
- [X] **T4 (P1, human: ~2h / CC: ~25min)** - backend - `POST /api/public/auth/login-identifier` with async scrypt, dummy compare, cap 5, semaphore, throttling
  - Surfaced by: Phase 2, eng review D2 and D3
  - Files: new public controller, `apps/backend/src/users/users.service.ts`, `apps/backend/src/users/credentials.ts`, `apps/backend/src/app.module.ts`, `apps/backend/package.json`
  - Verify: unit tests for all six resolver outcomes, the dummy-compare spy, and the sync/async hash parity test
- [X] **T5 (P1, human: ~40min / CC: ~8min)** - database - `auth_account_identities(user_ids, phone)` SECURITY DEFINER helper migration
  - Surfaced by: Phase 2 (Organization is RLS-scoped), eng review A1
  - Files: new `packages/database/prisma/migrations/*/migration.sql`
  - Verify: RLS matrix job, plus a manual `psql` check of the grant and the phone filter
- [X] **T6 (P1, human: ~40min / CC: ~8min)** - web - BFF route handler plus the `/api/public/auth` allowlist entry
  - Surfaced by: Phase 2 (proxy.ts does not expose it)
  - Files: `apps/web/src/app/api/public/auth/login-identifier/route.ts`, `apps/web/src/proxy.ts`
  - Verify: request through the Next dev server with no cookie returns 200
- [X] **T7 (P1, human: ~2h / CC: ~25min)** - web - login field, picker, and their states
  - Surfaced by: "What the user sees" 1 and 2
  - Files: `apps/web/src/app/(guest)/login/LoginForm.tsx`, new picker component, tests
  - Verify: component tests for phone path, pick, back, single match
- [X] **T8 (P1, human: ~1h / CC: ~12min)** - web - invite dialog disclosure
  - Surfaced by: "What the user sees" 3
  - Files: `InviteStaffDialog.tsx`, tests
  - Verify: collapsed by default, blank omits the key, typed address survives collapse attempts
- [X] **T9 (P1, human: ~1.5h / CC: ~18min)** - web/backend - Settings add-your-email state and the `PATCH /me` placeholder-only rule
  - Surfaced by: "What the user sees" 4, Phase 3
  - Files: `settings/page.tsx`, `users.service.ts`, `users.controller.ts`, tests
  - Verify: placeholder replace, duplicate 409, wrong password, phone-clear blocked
- [X] **T10 (P2)** - users table `No email` badge; the accept page shows the phone as the identifier when the address is a placeholder (`accept-phone-identifier`); backend search already matched phone in both shapes (verified `users.service.ts:1867`), so that half needed no change.
  - Surfaced by: "What the user sees" 5 and 6
  - Files: `admin/users/page.tsx`, `apps/backend/src/users/users.service.ts` (search predicate), `(guest)/invite/[token]/AcceptInviteForm.tsx`, tests
  - Verify: three cell cases, search by phone returning results from the API, accept page renders no `users.invalid` text
- [X] **T11 (P3, human: ~20min / CC: ~5min)** - web - normalize the invite dialog to the library's standard width `sm:max-w-md` and confirm every new interactive carries `data-qa`
  - Surfaced by: `paalstack-react-ui` dialog convention (user-mandated standard width)
  - Files: `InviteStaffDialog.tsx`
  - Verify: the three-field form and its footer still fit at 320x568, e2e audit passes
- [X] **T12 (P1, human: ~1.5h / CC: ~20min)** - backend and api-types - expire stale invites on create, accept both shapes in the EXPIRED filter, map the index P2002 to a friendly 409
  - Surfaced by: Phase 4, Decision 6. Without it a re-invite after expiry returns a raw 500.
  - Files: `apps/backend/src/invites/invites.tokens.ts` (helper), `apps/backend/src/invites/invites.service.ts` (create + P2002 map), `packages/api-types/src/invites.ts` (filter mapping), tests
  - Verify: re-invite after expiry succeeds and stores EXPIRED; live invite still 409 `INVITE_ALREADY_PENDING`; accepted past deadline untouched; list `status=EXPIRED` returns derived and stored rows; concurrent creates yield one invite plus one 409

## Design Review Completion Summary

```
+====================================================================+
|         DESIGN PLAN REVIEW - COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | No DESIGN.md; 6 docs in docs/designs       |
|                      | UI scope: login, invite, settings, table   |
| Step 0               | 4/10 initial; all 7 passes, fix as we go   |
| Pass 1  (Info Arch)  |  3/10 -> 10/10 after fixes                 |
| Pass 2  (States)     |  2/10 -> 10/10 after fixes                 |
| Pass 3  (Journey)    |  3/10 -> 8/10 after fixes                  |
| Pass 4  (AI Slop)    |  6/10 -> 9/10 after fixes                  |
| Pass 5  (Design Sys) |  4/10 -> 10/10 after fixes                 |
| Pass 6  (Responsive) |  2/10 -> 9/10 after fixes                  |
| Pass 7  (Decisions)  |  7 resolved, 2 deferred                    |
+--------------------------------------------------------------------+
| NOT in scope         | written (5 items)                          |
| What already exists  | written                                    |
| TODOS.md updates     | 0 proposed                                 |
| Approved Mockups     | 0 generated, 0 approved                    |
| Decisions made       | 7 added to plan                            |
| Decisions deferred   | 2 (listed below)                           |
| Overall design score | 4/10 -> 8/10                               |
+====================================================================+
```

Pass 4 classification: OPERATE throughout. No hard rejections: no card mosaics (the login is a single card that IS the interaction), no gradient or glow, no emoji, no generic hero copy, no stacked card grid in the table. Litmus: brand unmistakable via the existing heading and org name in the picker; one anchor per screen; headings scannable; each screen has one job.

Pass 5 note: no DESIGN.md exists, so this pass rated the plan's own component and token specifications against the live library. Recommend `/design-consultation` if you want a DESIGN.md, since six design docs now carry decisions a design system file would hold.

### Decisions deferred

- A one-time "you sign in with your phone" banner in Settings. Deferred: the placeholder state of the email field already says it, and a banner needs a dismissal mechanism the app does not have.
- Email verification and the reset gate. Deferred until a mailer exists; trigger is the first transport added, at which point `requestPasswordReset` must refuse `emailVerified: false`.

## Engineering Review

Scope record from `plan-eng-review`: feature answers E1-E4 (structure, throttling, candidate cap, resolver return), accepted scope unchanged from the plan with the smaller file arrangement adopted, pending remedies none.

### Reality lines

- REALITY: premise-table pass 6 claims tabulated with receipts, 0 unverified (`docs/plans/2026-11-21-staff-login-phone-or-email.md:196`).
- REALITY: already-done pass no prior phone-login work on `origin/main` since 2026-11-15; the hits are the invites feature (`invites.service.ts`).
- REALITY: surface-check pass `@nestjs/throttler` absent (`apps/backend/package.json`), `Public()` exists (`apps/backend/src/auth/public.decorator.ts:6`), phone index exists (`20261118120000_user_phone_partial_unique/migration.sql:52`).
- REALITY: binding-decisions pass prior branch decisions (ENGINEER role, portal IA, eng reviews 2026-09-04/09-12) do not conflict; plan Decisions 1-5 stand.
- REALITY: numbers finding 17 files and 2 new entry points before D1, 15 and 1 after [estimated]; scrypt ~100ms per verification and cap 5 gives ~500ms worst case [estimated, not measured].
- REALITY: deferred-asks pass no linked issue, nothing requested-but-omitted.
- REALITY: pr-count pass no `.gstack/ship-policy.json`, default is one PR for the wave.

### 1. Architecture

- **A1 (P1, confidence 8, source: static read)** `auth_account_identities(user_ids)` alone lets any caller holding user ids read their organisation names, and the ids come back in resolver responses. Fixed by taking `phone` as a second argument and filtering on it, so the helper answers only for the number that was just proved.
- **A2 (P1, confidence 9, source: static read)** Per-IP throttling does not stop many IPs from saturating the four libuv threads with scrypt. Fixed by a semaphore capping in-flight verifications at 2.
- **A3 (P2, confidence 7, source: static read)** Two scrypt implementations can drift on the `salt:key` parse or the parameters. Fixed by making the async one primitive and having the sync wrapper delegate, with a parity test.
- **A4 (P2, confidence 6, source: static read)** A `@Public()` route carrying a password is an exception to the global guard. `AGENTS.md` permits it where the credential is in the call itself, and `invites-public.controller.ts:77` is the precedent. Verified at build time, no code change.
- **A5 (P3, confidence 9, source: user decision E4)** The resolver returns the account email, so a colleague sharing a phone and password learns that address. Accepted, recorded in Phase 2.

### 2. Code quality

- **Q1 (P2, confidence 9, source: static read)** `displayIdentifier` needs `formatPhone`, which lives in the web app, so putting it in `api-types` would drag presentation into the contract package. Moved to `apps/web/src/lib/identity.ts`.
- **Q2 (P2, confidence 7, source: static read)** Synthetic addresses must be produced in exactly one place or the `.invalid` convention spreads. `makePlaceholderEmail()` sits beside the invite token helpers, and `isPlaceholderEmail` is the only reader of the convention.
- **Q3 (P3, confidence 8, source: static read)** The login field becomes a union but must keep a single shape error string, matching the account-enumeration defence already documented in `LoginForm.tsx:5-23`.

### 3. Tests

- **T1 (P1, confidence 9, source: static read)** A wall-clock timing-parity test fails on loaded CI for reasons unrelated to the code. Replaced with a spy asserting the dummy comparison runs on a zero-candidate request.
- **T2 (P2, confidence 8, source: proposed)** The definer helper needs a DB-backed case proving it refuses ids whose phone does not match, not only that it returns names.
- **T3 (P2, confidence 7, source: proposed)** Nothing in the current plan exercises the BFF route end to end. One Playwright case added, next to the existing invite audit.
- **T4 (P3, confidence 8, source: static read)** `AcceptInviteForm.tsx:200` renders `preview.email`, so a placeholder would leak to its owner. Covered by an explicit assertion.

### 4. Performance

- **P1 (pass, source: static read)** The candidate query is index-served: phone is the leading column of `User_phone_organizationId_key` and the partial predicate matches the query exactly.
- **P2 (P2, confidence 7, source: estimate)** Five candidates at ~100ms each is ~500ms of CPU; the semaphore and the 10/min throttle bound it. Common case is one match, roughly 100ms plus two queries.
- **P3 (P2, confidence 8, source: static read)** Verifying candidates one at a time means up to five `Account` round trips. Fixed by one `findMany` over the candidate ids followed by in-memory verification, so the resolver is two queries regardless of candidate count.

Dispositions: A1, A2, A3, Q1, Q2, Q3, T1, T2, T3, T4, P3 accepted and folded into the plan. A4 verified, no change. A5 accepted by decision E4. P1 pass, no action.

E5 (added after this review, at the owner's request while the plan was held for approval): invite expiry. `create()`'s live-invite check filters on `expiresAt > now` but the partial unique index only keys on `status = 'PENDING'`, so a re-invite after expiry passes the app check and dies on a raw P2002 (`invites.service.ts:235-249` against `staff_invites/migration.sql:72-74`). Accepted fix: persist EXPIRED lazily inside `create()`'s transaction, teach the EXPIRED list filter both shapes, and map the index violation to `INVITE_ALREADY_PENDING`. `resend()` already revives in place and needs no change. Recorded as Phase 4, Decision 6, Task T12. Eng Review row updated to 13 findings and 5 decisions.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | - |
| Outside Review | `/codex` consult (codex-cli 0.169.0, ollamacloud/deepseek-v4.1-flash) | Independent 2nd opinion | 1 | completed | 6 production risks, 6 security/correctness, 7 under-specified, 4 simplification |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 13 findings, 0 critical gaps, 5 decisions |
| Design Review | `/plan-design-review` | UI/UX gaps | 3 | clean | score: 4/10 -> 8/10, 7 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | - |

- **OUTSIDE COVERAGE:** codex-cli, design and plan consult phase, completed. Its findings are folded into this revision; the wrapper ran the same model family as the host harness, so it is a fresh-context review rather than a cross-model one.
- **VERDICT:** ENG + DESIGN CLEARED - ready to implement.
- **UNRESOLVED DECISIONS:**
- Settings sign-in banner for phone-only accounts (deferred; the placeholder helper text covers it today).
- Email verification and the password-reset gate (deferred until a mailer exists).
