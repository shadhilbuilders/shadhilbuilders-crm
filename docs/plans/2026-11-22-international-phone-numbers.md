<!-- /autoplan restore point: "/home/paalstack/workspace/shadhil-projects/shadhilbuilders-crm/.gstack/tmp/autoplan/main-autoplan-restore-20261122-035207.md" -->

## Implementation plan

# International lead phone numbers

## Problem

The CRM assumes every phone number in it is Indian. That assumption is now false, and the product silently mangles or drops the numbers that are not.

Six defects, each verified against the current tree or measured against the database:

1. **Silent rewriting into an Indian number.** `normalizePhoneDigits` (`packages/api-types/src/common.ts:72`) prepends `91` to any bare 10-digit value starting 6-9. Measured with `libphonenumber-js@1.13.17`: `parsePhoneNumberFromString('6502345678','IN')` returns `+916****5678` and reports `isValid() === true`. A US lead is stored as somebody else's Indian number, and takes that number's per-org unique slot.
2. **A digits-only international value is parsed as Indian.** `parsePhoneNumberFromString('16502345678','IN')` returns `+911****5678`, also "valid": the leading `1` is read as an Indian trunk digit. Even a caller sending full international digits is corrupted.
3. **No way to type a foreign number.** `PhoneNumberInput` (`apps/web/src/components/shared/PhoneNumberInput.tsx:40`) sanitizes with `digitsOnly(value, 10)` and `maxLength={10}`; the eleventh digit is dropped as you type.
4. **A lead edit never updates the canonical column.** `leads.service.ts:1738` writes `phone` only. `phoneE164` is written at create (`:1072`) and nowhere else, so a telecaller correcting a number leaves WhatsApp outbound and the inbound lookup on the old one.
5. **The unique key is the wrong column.** `@@unique([organizationId, phone])` (`schema.prisma:1015`) and the duplicate check (`leads.service.ts:1036`) both key on `phone`. Two leads in different countries can legitimately share a national string; only `phoneE164` tells them apart. That is the exact scenario this feature exists for.
6. **Rows exist with no canonical number, and inbound would drop.** 34 of 269 local `Lead` rows have `phoneE164 IS NULL` (measured). Separately `toE164` (`whatsapp.client.ts:129`) only strips punctuation, and Meta's inbound `from` is digits-only: `parsePhoneNumberFromString('14155552671')` with no default country returns `null` (measured). Replacing `toE164` naively would make the webhook ignore every inbound message.

Measured country distribution in the local database (269 leads): `91` 220, NULL 34, `98` 12, `58` 1, `55` 1, `12` 1. Foreign numbers are already in the data, and `12` is not an assigned country code, so at least one stored value is already nonsense. The demand question is not "will foreign leads arrive" but "how many of the ones we have are already wrong".

What exists and must be reused:

- `Lead.phone` and `Lead.phoneE164` are two columns with two per-org unique indexes; `phoneE164` is already what WhatsApp sends to and what the inbound webhook looks up.
- The webhook already resolves the org per candidate, so it does not need the phone to carry tenancy.
- `telUrl` already emits `tel:+` for the shapes it recognises.

## Decision

**`phoneE164` is the identity; `phone` is a normalized copy of what was typed.** Uniqueness moves to `phoneE164`. Every write derives both from one helper, in the same transaction, on create and on update.

**Storage stays digits-only (`919876543210`), not `+`-prefixed.** Meta's `to` field is digits, every existing row and lookup uses that shape, and the `+` is a parsing concern rather than a storage one. One adapter (`toParseable(digits)` to `+<digits>`) exists so libphonenumber is never handed a bare digit string, which is the root of defect 6.

**Parse order is digits-first, then national with an explicit country, and only then the Indian default.** Measured behaviour:

| input                          | rule                            | result                                   |
| ------------------------------ | ------------------------------- | ---------------------------------------- |
| `+919876543210`                | explicit `+`                    | `919876543210`, valid                    |
| `16502345678`                  | `+` + digits validates          | `16502345678`, NOT `91...`               |
| `14155552671`                  | `+` + digits validates          | `14155552671`, webhook safe              |
| `9876543210`                   | `+` fails, then 10 digits 6-9   | `919876543210`, today's behaviour kept   |
| `6502345678` with `country=US` | national + explicit country     | `16502345678`                            |
| `6502345678` with no country   | `+` fails, not an Indian mobile | **rejected**: "include the country code" |

That last row is the point: with no information, refuse rather than invent a country. A refusal is recoverable; a number rewritten to another country's subscriber is not.

**Validation and formatting come from `libphonenumber-js`, imported as `/min`, through one wrapper module.** `api-types` is imported by the web app, so the default entry's full metadata would land in the client bundle.

**The input is ours, not the library's.** `react-phone-number-input@3.4.18` is used for behaviour only (as-you-type formatting, caret handling, country list); its default export renders its own select and CSS. `@paalstack/react-ui` is shadcn/ui on Base UI and exports every primitive that `omeralpi/shadcn-phone-input` is built from, verified in the installed `dist/index.d.ts` (v1.7.2): `Popover` / `PopoverTrigger` / `PopoverContent`, the `Command` family, `InputGroup` with `addonStart`, `Combobox` with its parts. So that component ports nearly one-for-one; what does not port is its `<Button>`-in-a-`div` shell, because this repo's rule is that every single-line input goes through `InputGroup`.

## Scope

In scope: the identity and every write path for lead phone (create, edit, inbound and outbound WhatsApp, the public landing path), staff phone, invites, the accept form, display and `tel:` links, and the new input.

Out of scope: repairing numbers already rewritten by defect 1 (the true number is not recoverable from the stored value; it needs an office-verified list), OTP or any verification step, and per-country formatting for records this change does not edit.

## Phase A - identity and write paths (P1)

### A1 - One parser module

`packages/api-types/src/phone.ts` (new)

- `parseStoredPhone(raw, country?)` per the table above, returning `{ digits, country }` or throwing a message a form can show.
- `formatStoredPhone(digits)` for display: always `+CC` for a non-domestic number. An Indian call centre rendering a US number in national format makes it look local.
- `toParseable` / `fromParseable` so no caller hands libphonenumber a bare digit string.
- `normalizePhoneDigits` becomes a thin delegate, or is deleted with its callers updated: its `91` guessing is the corruption.

### A1b - The module contract (amended by the DX review)

The first draft of A1 exported `parseStoredPhone(raw, country?)`. Three problems, all fixed here.

- **An optional second argument is the Indian default wearing a different shirt.** Omit it and a 10-digit mobile is silently rewritten to `91...`, which is defect 1 reachable by forgetting an argument, invisible at the call site. The country must be a named input, never an omission.
- **`parseStoredPhone` misdescribes three of its four callers**: typed form input, Meta's already-canonical `from`, and a backfill over historical rows are not reading values this module wrote.
- **`{ digits, country }` collides with the DTO's `phoneCountry`.** Two meanings, one word.

```ts
export type PhoneInput =
  | { source: 'typed'; raw: string; country: CountryCode | null } // null means "no country was chosen"
  | { source: 'e164'; digits: string } // Meta inbound, canonical reads
  | { source: 'legacy-national'; raw: string }; // the ONE Indian guess, by name

export function parsePhone(input: PhoneInput): { e164: string; region: CountryCode | null };
export function leadPhoneColumns(input: PhoneInput): { phone: string; phoneE164: string };

export class PhoneParseError extends Error {
  reason: 'EMPTY' | 'UNPARSEABLE' | 'COUNTRY_REQUIRED' | 'WRONG_COUNTRY' | 'UNKNOWN_COUNTRY';
  field: 'phone';
}

export const DOMESTIC_COUNTRY: CountryCode;
export function formatPhone(e164: string, opts?: { domestic?: CountryCode }): string;
```

- **`leadPhoneColumns` is the load-bearing export.** It returns exactly the two columns Prisma needs, so "wrote `phone` and forgot `phoneE164`" stops being expressible at the call site instead of being a rule a human remembers.
- **`legacy-national` keeps the accepted Indian-guess behaviour while removing the way to reach it by accident.** It is named, importable and grep-able; deleting it would re-litigate a decision already taken.
- **`toParseable` / `fromParseable` stay module-private.** Exporting them invites a caller to hand their output to their own libphonenumber call, which resurrects defect 6.
- **`formatPhone(e164, { domestic })` makes the call-centre assumption a parameter** instead of a constant buried in the implementation.
- **`PhoneParseError` is not optional decoration.** A plain `Error` thrown from a service is mapped by `global-exception.filter.ts` to `500 INTERNAL_ERROR`, which is the exact bug `parse-service-body.ts` was written to end. Each layer translates `reason` into its own shape; the message strings live in one exported `PHONE_ERRORS` map so the app, the API and the landing cannot drift.

### A2 - Contracts carry the country

`packages/api-types/src/leads.ts`, `public-leads.ts`, `users.ts`, `invites.ts`, `auth.ts`

- `phoneCountry?: CountryCode` on every DTO that accepts a phone; default `IN` only where the caller is genuinely Indian (staff invite, profile).
- **A country code must be a real ISO code or the request fails.** `CountryCode` is a type, not a runtime guard, so the DTO validates the value against the library's country list and 400s on anything else. A wrong code that quietly falls back to `IN` is the same defect one layer up.
- `PhoneSchema` stops being a `.transform`: a transform hides the raw value from a sibling `superRefine`, so the country cannot be used at validation time. Canonicalise once in the service.
- `PublicCreateLeadDtoSchema` gains `phoneCountry` and passes it through the re-parse at `public-leads.service.ts:109`. Without this the landing page, the main acquisition source, stays broken regardless of the CRM UI.

### A3 - One write path

`apps/backend/src/leads/leads.service.ts`, `apps/backend/src/public-leads/public-leads.service.ts`

- Create and update both write `phone` + `phoneE164` from `parseStoredPhone` in one transaction, with audit before/after on both columns.
- `public-leads.service.ts:295` derives its repeat-enquiry key with `toE164` and looks up `OR: [{ phone }, { phoneE164 }]` at `:301`. If create moves to the new parser and this stays on `toE164`, a repeat enquiry from a foreign number stops matching its lead and silently creates a duplicate. Same helper, same change.
- **Both columns hold canonical digits.** `PhoneSchema` is a transform, so `dto.phone` already arrives normalized; `phone` has never held the typed string. Say so in the `schema.prisma` docblock and stop describing `phone` as the display value. The two columns agree from here on, which is what makes either one safe to read.
- A P2002 on update currently has no rescue and surfaces as a 500. Mirror the create path: pre-check, then map the constraint to a 400 that names the number. `users.service.ts:113` is the repo's pattern for attributing a constraint to a field.
- Tests: create, edit, edit-to-another-country, and a repeat public enquiry from a foreign number matching the existing lead rather than duplicating it.

### A4 - Migration

- Backfill `phoneE164` for NULL rows whose `phone` parses unambiguously; the same query runs against prod first and reports what it cannot resolve instead of guessing.
- Drop `@@unique([organizationId, phone])`, keep `@@unique([organizationId, phoneE164])`. Pre-check for rows that would collide, as a hard stop.
- Report, do not repair, rows whose stored value is provably wrong (the `12` bucket).

### A5 - WhatsApp both directions

`apps/backend/src/webhooks/webhooks.controller.ts:332`, `apps/backend/src/whatsapp/whatsapp.client.ts:129`

- Replace `toE164` with the digits-first parser. A Meta-shaped payload must never be dropped: test `14155552671` and `919876543210`.
- Count a parse failure instead of failing silently; this is the one place a bad number loses a customer.

### A6 - Staff login and user search

`apps/backend/src/users/login-identifier.ts:49`, `apps/backend/src/users/users.service.ts:200`

- Both call the IN-default normalizer today, so a `+971` staff member cannot sign in by typing a national number and an admin search may miss them. Migrate both to the country-aware parser, or explicitly scope staff to India in this change and say so. Recommendation: migrate both.
- This is an auth path: keep the timing-equal dummy-hash branch exactly as it is, and add a test for a foreign staff number. A wrong change here is a credential-enumeration surface, not a bug.
- Lead search (`leads.service.ts:344`) interpolates the term through `Prisma.sql`, which is parameterised. The parsed term must go through the same parameterised path and stay inside the existing `try` with the DTO's length cap; never build the search term by concatenation.

## Phase B - the input and its surfaces (P1)

### B0 - Country state contract

The state machine is the design decision; the primitives are just how it is drawn. Decided here so the implementer does not invent four different answers.

- **The country is a form value, not component state.** `phoneCountry` is registered in the form alongside `phone`, submitted with it, and validated like any other field. A picker that only changes what the input looks like is how defect 1 gets rebuilt inside the new widget.
- **The trigger always shows the country that will be stored** (dial code, plus ISO code or flag). A default of `IN` is acceptable only because it is visible: the telecaller seeing `+91` beside the field is not the same as a silent prepend. Changing the trigger changes the stored country even before the number is valid.
- **An explicit `+` in the input always wins** and moves the trigger to the parsed country. Pasting `+1 650 234 5678` while India is selected must store the US number, not reinterpret it as Indian.
- **Changing the trigger preserves the digits and revalidates.** It never clears the field and never rewrites the subscriber part. An invalid result for the new country shows the error and leaves the digits editable.
- **A national-only number with no country selected is rejected** with "Select a country, or enter the number with its country code". A country-specific failure says "That does not look like a valid US number".
- **Prefill never guesses a region.** Stored digits are authoritative. Where the calling code is shared (`+1` US/Canada, `+7` Russia/Kazakhstan) or libphonenumber returns no region, the field shows the international form and the trigger shows an international state; it does not pick a country and then reformat on the next keystroke.
- **The form submits canonical digits plus country, never the formatted display string**, so `phone` and `phoneE164` cannot diverge through the UI.
- **A number that fails to parse makes the `tel:` link non-dialable** rather than falling back to today's Indian guess, and the row reads as "no valid number" instead of a raw string.

### B1 - `IntlPhoneInput`

`apps/web/src/components/shared/IntlPhoneInput.tsx` (new)

- Field shell `InputGroup`: `addonStart` is the country trigger (`Popover` + `PopoverTrigger`), `inputProps` carries the real `type="tel"` input with `data-qa`.
- **Content is `PopoverModalContent`, not a hand-assembled `Command`.** The library already composes the search input, list, empty state and loading state behind one `options` prop, and `MultiSelect` uses it, so every picker in the app behaves the same. Assembling `CommandInput` + `CommandList` + `CommandEmpty` + `CommandItem` by hand would be two relationships kept in sync by hand, which is the correction the owner already made once on `PlotSearch`.
- **Search matches name, dial code and ISO code** (`971`, `United Arab Emirates`, `AE`), pinned as a test rather than assumed from whichever library sorts the list.
- **`IN` is pinned in its own unfiltered group above the results**, because both candidate libraries re-sort on input and index 0 stops being first after the first keystroke.
- **No flags.** A flag repeats what the dial code says, `country-flag-icons` is only a transitive dependency that pnpm strict mode will not resolve without a direct declaration, and emoji flags render as two letters on Windows, which is where this CRM's desktop users are. The trigger shows the dial code plus the country in its accessible name; the list shows country name, dial code and ISO code.
- **Integration contract:** the dependency is `react-phone-number-input` (not yet installed; the plan adds it) used through its headless surface for formatting and caret behaviour, with `libphonenumber-js` supplying parsing and the country list. If the headless path cannot be pinned to a named export, render from `getCountries()` and format with `formatAsYouType`, rather than rendering the library's own country select.
- **Value contract, so seven call sites cannot fork:** one controlled `value` in E.164-with-`+` form, `defaultCountry` for bare national input, and an `onValueChange(value, country)` that reports the country alongside. No second registered RHF key is required of call sites; the country travels with the value.
- **Accessibility, as acceptance criteria:** `id={field.name}` on the real input, because the Form's `FieldLabel htmlFor` points at the field name and a custom renderer is never given an `id`, so today the phone field has no programmatic label at all; spread `aria-invalid` and `aria-describedby`; trigger `aria-label="Country calling code: India (+91)"`; Arrow/Home/End/type-ahead/Enter/Escape on the list; Tab order is trigger then input (that is the DOM order), and focus returns to the **input** after a country is picked; `inputMode="tel"`, never `numeric`, or `+` is unreachable on iOS.
- **Responsive, as acceptance criteria:** at 320px the Dialog is 288px while `PopoverContent` is hardcoded `w-72` (also 288px), so the list gets a width tied to the field and a `max-h` with internal scroll. Below `sm` the list opens as a full-width `Sheet`; above it, a popover with collision padding.
- **Size is a three-value prop, not two:** `sm` for the dense dialogs, `md` for full-page forms, `lg` (44px) for the surfaces that already run at `min-h-11` (Settings profile, invite accept). The trigger uses `self-stretch` so it follows the group rather than hardcoding a height.

### B2 - The seven call sites

`apps/web/src/app/[orgSlug]/projects/[projectSlug]/leads/new/page.tsx:202`, `apps/web/src/components/leads/LeadEditDialog.tsx:141`, `apps/web/src/app/[orgSlug]/admin/users/components/CreateUserForm.tsx:257`, `apps/web/src/components/users/UserActionDialogs.tsx:140`, `apps/web/src/app/[orgSlug]/admin/users/components/InviteStaffDialog.tsx:226`, the invite accept form, `apps/web/src/app/[orgSlug]/settings/page.tsx`

- Swap in `IntlPhoneInput`, drop the "10-digit mobile number. +91 is added automatically." copy, prefill with `parseStoredPhone` instead of `toPhoneInputValue`.

### B3 - Display and dial

`apps/web/src/lib/phone.ts`

- `formatPhone` shows `+CC` for non-domestic numbers; `telUrl` uses the parser with today's behaviour as fallback; `toPhoneInputValue` and `PhoneNumberInput` are deleted once B2 lands.

### B4 - Tests

- `api-types`: one case per row of the decision table, asserting stored digits AND that `6502345678` never becomes `91...`. This is the regression test for defects 1 and 2.
- `backend`: create, edit, edit-to-foreign, inbound webhook with a Meta-shaped and an Indian payload, duplicate check on `phoneE164`, and a cross-country collision (same national string, two countries, both allowed).
- `web`: `IntlPhoneInput` emits digits + country and rejects an incomplete number on blur (createRoot + act harness; this app has no `@testing-library/react`).
- `e2e`: create a lead with `+1`, assert the cell shows `+1 ...` and the `tel:` href carries `+1`; then edit that number and assert the canonical value moved.

### A7 - Guards that make the invariant structural

Prose does not survive the next engineer or the next agent. Three guards, each following a pattern already in this repo.

- **Database:** `CHECK (phoneE164 IS NULL OR phone = phoneE164)` in the migration that lands after the backfill. Today `phone` and `phoneE164` disagree on the foreign rows, which is the defect; the constraint is what stops them disagreeing again. It goes last, after the backfill is verified, because it will fail on today's data by design. 34 NULL rows pass (`phoneE164 IS NULL`).
- **Compile time:** a local ESLint rule `phone-write-uses-helper` flagging a `lead.create` / `lead.update` data literal that sets `phone` without `phoneE164`. Precedent and wiring exist: `apps/backend/eslint-rules/zod-parsed-body.mjs`, tested by `zod-parsed-body-rule.test.ts`.
- **P2002 attribution:** the unique index is `@@unique([organizationId, phoneE164])` (`schema.prisma:1016`), and the constraint name is `Lead_organizationId_phoneE164_key`. `meta.target` does not exist under `@prisma/adapter-pg@7.10.0` (`users.service.ts:105,137`), so the global filter reports "A record with these values already exists". Reuse `violatedUserIndex()` (`users.service.ts:116`) to attribute the field before mapping to a 400.
- **Migration ordering fails closed in SQL, not in prose.** The collision pre-check becomes `DO $$ BEGIN IF EXISTS (...) THEN RAISE EXCEPTION '...'; END IF; END $$;` inside the migration, following `20261009040000_visit_lead_state_backfill`. Archive the pre-check output before dropping the old index, and commit the reverse migration with a comment saying it can legitimately fail: re-adding `@@unique([organizationId, phone])` breaks once two rows share a national string, which is the point of the change.
- **One page of ADR**, `docs/adr/0002-phone-identity-is-e164.md`: the plan's decision table as Decision, the six defects as Context, "retire `phone`" and "keep the IN default" as Alternatives. `docs/adr/README.md`'s bar is "expensive to reverse, surprising without its context, a real trade-off", which this clears.
- **Inbound parse failures must not be a counter nobody reads.** `webhooks.controller.ts:334` returns `ignored` and answers Meta with 200, so an unparseable inbound message is a lost customer recorded as success. Write a `WhatsappUnknownContact` row (the table and service exist) beside the counter.

## Phase C - WhatsApp reachability (P2)

Sending a template to a number that is not on WhatsApp wastes the attempt and leaves the operator unsure whether it went. The state has to exist, but it has to be honest about where it comes from.

**There is no pre-flight check.** WhatsApp Cloud API has no endpoint that answers "is this number on WhatsApp". The evidence comes from two places only: the person writes to us (an inbound message), or a send comes back with Meta error `131026` (undelivered / not a WhatsApp user). `whatsapp.client.ts:245` already converts a `message_status: "failed"` body into `accepted: false` with the error code, so the signal is already captured; nothing needs to be added to the client.

**Derived state, three values, no guessing:**

| state         | evidence                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `REACHABLE`   | any inbound message from the lead, or an outbound status receipt of `delivered` / `read`       |
| `UNREACHABLE` | the most recent outbound attempt returned `131026`, with no inbound message after it           |
| `UNKNOWN`     | nothing yet. This is the state of every lead that has never been messaged and never written in |

`131030` (recipient not on the test allowlist) must not be read as unreachable: it means the sender is in test mode, not that the person lacks WhatsApp.

**Storage:** derive it from `Message` direction plus `OutboundMessage.lastError` / status for the lead detail, which is one query and always current. Add a nullable `Lead.whatsappState` column only if the leads list needs to filter or badge on it; do not add it up front.

**UI:**

- Lead chat pane: when `UNREACHABLE`, a banner states what is actually known, "The last message to this number was not delivered. WhatsApp reports it is not on WhatsApp." Templates and freeform sends are disabled behind that banner, with two escapes: **Send anyway** (numbers do change hands, and the flag is evidence, not a truth) and **Re-check**, which clears the flag and allows one more attempt because a retry is the only way to learn anything new.
- When `UNKNOWN`, the composer stays enabled and the pane says nothing; the first failure is what teaches it.
- Leads list: an optional muted badge, only if the column is added.

**Tests:** an outbound attempt that returns `131026` flips the state to `UNREACHABLE` and the composer renders disabled; an inbound message flips it back to `REACHABLE`; `131030` leaves it `UNKNOWN`; the banner copy never claims a check happened before the first send.

**As built (2026-11-22).** `apps/backend/src/leads/whatsapp-reachability.ts` derives the three states from an inbound `Message` and the newest `OutboundMessage`, and `GET /leads/:id` carries the verdict as `whatsapp` on `LeadDetail`. The chat pane renders the banner in place of the composer when the verdict is `UNREACHABLE`, with the two escapes. `Send anyway` is local state for that render, and `Re-check` refetches the lead, which is where the verdict comes from. `UNKNOWN` says nothing, as the table above requires. Covered by six branch tests on the derivation and five render tests on the pane.

**Depends on:** A4, because the state is keyed on `phoneE164`. A number that was silently rewritten to `91...` would produce a reachability verdict about a different person.

## Corrections forced by measurement

The Eng review measured the database instead of trusting the plan's bucket counts, and three claims in this document were wrong. They are corrected here and the sections that carried them are superseded.

**1. There are no foreign leads in this database, and "demand evidenced by 15 foreign rows" was false.** The non-`91` prefix count came from `left(phoneE164, 2)`. The actual rows are Indian seed data whose `phoneE164` is missing its prefix: `9876500001` (Priya Sharma), `9876500010` (Rohan Gupta), `98629146343`, and demo rows named `asdasd`. `left(…,2)` reads `98` because the number starts with 98, not because Iran is involved. The six defects are independently real and the fix stands on its own; the evidence for demand is that a CRM accepting work from anywhere cannot represent a non-Indian number at all, not a row count.

**2. `phone` and `phoneE164` do not hold the same value today: 144 of 269 rows disagree** (`select count(*) where "phoneE164" is not null and phone <> "phoneE164"`, local database, measured). The earlier claim that both columns were already identical was wrong. That makes the `CHECK (phoneE164 IS NULL OR phone = phoneE164)` guard in A7 more important, not less, and it means the backfill has real work to do rather than confirming a happy path.

**3. The 34 NULL rows split into two populations, and one of them blocks the identity constraint.** Nineteen match a bare Indian mobile (`^[6-9][0-9]{9}$`) and backfill cleanly. The other fifteen do not, and they are placeholders from the burden seed set ("B1 burden 0", and similar). They cannot be parsed, so they sit permanently outside `@@unique([organizationId, phoneE164])`, and Postgres treats NULLs as distinct, which means the identity column would stay nullable and the plan's own invariant would be unenforceable.

### A4b - The migration, as measured

- **Repair, do not report, the un-prefixed Indian rows.** `9876500001 → 919876500001`. These are the rows most likely to duplicate each other once the `phone` index is gone, so "report only" hides them exactly when they matter.
- **Delete or rewrite the fifteen masked placeholder rows** (seed/demo, not customers), then `ALTER COLUMN "phoneE164" SET NOT NULL` in the same migration and flip `schema.prisma:961` to `String`. A nullable identity key is a bug with a schedule.
- **`packages/database/src/seed.ts:752` upserts on `organizationId_phone`,** a compound selector that ceases to exist when the index drops. Its `create` block never sets `phoneE164`, so a naive rekey either fails Prisma validation or turns the idempotent upsert into a duplicate generator. It must parse and write `phoneE164` and upsert on `(organizationId, phoneE164)`.
- **`packages/database/test/lead-phone-per-org.test.ts:129` hard-codes `constraint:Lead_organizationId_phone_key`** and goes red on a correct migration; `:143` pins `ACCEPTS many leads with no phoneE164` open. Both move with the change.
- **Index swap without locking the table:** `CREATE UNIQUE INDEX CONCURRENTLY` outside the migration transaction, `DROP INDEX CONCURRENTLY` for the old one. State the production row count before running it; 269 is a dev snapshot.
- **The rollback for the constraint is "choose which collided row to keep", not a migration revert.** Re-adding `@@unique([organizationId, phone])` fails by design once two countries legitimately share a national string.

### A3b - Display must not throw

`formatPhone` today returns masked values untouched (`if (phone.includes('*')) return phone`), pinned by `phone.test.ts:80`. Fifteen live rows depend on that, and `PhoneNumber` calls it unguarded inside the leads table, the user cards, the detail view and the invites table, so a throwing parser white-screens four screens. The parser returns a result object; `formatPhone` and `telUrl` keep the masked-and-garbage passthrough.

**Three normalizers, not two.** `whatsapp.client.ts:129` is the one the plan names, but `webhooks.controller.ts:584` holds a module-local copy that the `:332` call site actually resolves to. Both are deleted in favour of the shared parser, or an implementer following A5 will either hit an import error or add a third variant.

### A6b - Search, corrected

Lead search does not get a parser. `leads.service.ts:344` is a plain ILIKE with no `try` and no normalisation; the `try`/length-gate/fallback the plan described lives in `users.service.ts:190-210` `searchPhoneTerms`. Feeding a two-character term through libphonenumber would 500 the leads list on the first keystroke. Extract `searchPhoneTerms` and share it: a raw digit run plus the canonical form as a second ILIKE alternative, in both searches. Escape `%` and `_` in the term while there, because a search for `_` currently matches every row.

### A2b - The landing gate rejects the numbers this feature exists for

`packages/api-types/src/public-leads.ts:71` `isPlausiblePublicPhone` requires 10 to 15 digits before the service is ever reached. A UAE mobile is 9 digits and a Singapore or Hong Kong mobile is 8, so the main acquisition path dies at the DTO. The floor becomes country-aware when `phoneCountry` is present (`isPossiblePhoneNumber` on the `toParseable` form); the 10 to 15 digit rule stays only for requests that carry no country.

### A1c - Import seam

`api-types` is CommonJS with a barrel `index.ts`, so a web file importing anything from it pulls the module graph that now includes 20 KB gzip of metadata. Add an `exports` entry for `./phone` and import `@shadhil/api-types/phone` from the field, so the metadata lands only on routes that render a phone.

## Risks and rollout

- **The landing form is a cross-repo release dependency, not an open question.** Phase A makes the server _accept_ a country and parse digits-first, but `shadhil-landing-page` still sends a bare national number. Until that form carries a country or sends the `+` form, a US enquiry from the main acquisition source is still ambiguous. Either ship that change in the landing repo with this work, or say plainly that Phase A fixes the CRM and the landing stays Indian-only until its own change lands. Do not claim the landing path is fixed while the sender is untouched.
- **Ambiguous input now refuses.** A bare 10-digit non-Indian number with no country is rejected instead of guessed. That is the fix, but it changes behaviour for any client doing it today; the message must say what to do.
- **Two libphonenumber copies** unless `api-types` and `react-phone-number-input` resolve one version. `libphonenumber-js@1.13.12` is already in the lockfile via `class-validator`, so pin to that and assert a single instance.
- **Metadata weight** in the web bundle through `api-types`; the `/min` import is load-bearing, so measure the delta before and after.
- **Migration order**: backfill and verify before the constraint changes; the collision pre-check is a hard stop.
- **Rollout**: A1-A3 fix paths that are demonstrably broken, so they ship without a flag; A4's constraint change waits on a verified backfill; any rise in webhook parse failures is a rollback signal.

## Open questions

1. Should the country trigger show a flag, or only the dial code and ISO code? `country-flag-icons` is already a transitive dependency of `react-phone-number-input`, so the cost is bundle weight rather than a new package. Dial code plus ISO code is the safe default; flags are a visual upgrade.
2. Answered during review: do not retire `phone`. Both columns hold canonical digits after A3, so retiring one is pure cleanup with a real migration and no user benefit.

## Review record

<!-- autoplan-accepted:ceo -->

- A lead update must write `phone` and `phoneE164` together; the invariant is "both denote the same subscriber".
- `public-leads` repeat-enquiry derivation moves to the same helper as create, or a foreign repeat enquiry duplicates its lead.
- `phoneCountry` is validated as a real ISO code and rejected loudly; no silent IN fallback.
- A P2002 on lead update is mapped to a 400 that names the number, not a 500.
- International staff sign-in and user search use the country-aware parser, with the timing-equal invalid branch preserved and a foreign-staff test.
- Lead search keeps its parameterised query and length cap.
- `api-types` imports `libphonenumber-js/min`, and the dependency resolves to the version already in the lockfile (1.13.12).

<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:design -->

- The country list renders through the library's `PopoverModalContent`, not a hand-assembled Command block.
- Search matches country name, dial code and ISO code; `IN` is pinned in its own unfiltered group.
- No flags anywhere in the field; the trigger's accessible name carries the country.
- The input is `type="tel"` with `inputMode="tel"`, never `numeric`.
- The field owns its `id` so the Form's label resolves, and spreads `aria-invalid` and `aria-describedby`; a test asserts the label-to-input association.
- Tab order is trigger then input; after selecting a country focus returns to the input.
- Three sizes: `sm` dialogs, `md` full page, `lg` for the `min-h-11` surfaces; the trigger uses `self-stretch`.
- One controlled `value` in E.164-with-`+` form plus `defaultCountry`, so seven call sites share one representation.
- The state table is binding: paste of an international number, country switch preserving digits, clearable empty, disabled trigger alongside a disabled input.
- 320px: the list is as wide as the field, scrolls internally, and becomes a Sheet below `sm`.

<!-- /autoplan-accepted:design -->

CEO dual-voice review, 2026-11-22. The outside voice returned eleven findings, four Critical: the landing path still corrupts through the IN default, the inbound webhook would drop every message, lead edits never update `phoneE164`, and uniqueness keys on `phone` rather than the canonical column. The native voice returned the same two write-path criticals and added one both of us had missed: `public-leads.service.ts:295` derives its repeat-enquiry key with `toE164`, so changing only `leads.service.ts` makes create and dedupe disagree and a foreign repeat enquiry silently duplicates.

Every load-bearing claim was re-verified here rather than accepted on trust: parser behaviour by running `libphonenumber-js` against the exact inputs, the write paths and DTO plumbing by reading `leads.service.ts`, `public-leads.service.ts` and `common.ts`, the dependency by finding `libphonenumber-js@1.13.12` already in `pnpm-lock.yaml`, and the data by querying the local database. One native finding corrects this plan's own wording: `phone` has never held the typed string, because `PhoneSchema` transforms on the way in, so the two columns are meant to be identical and the docblock should say that.

| Dimension               | Native                                                                     | Outside                                    | Consensus                                           |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Premises valid?         | Phone identity is wrong in six places; demand evidenced by 15 foreign rows | Premise "leads arrive anywhere" unmeasured | Agreed the defects are real; measurement now exists |
| Right problem?          | Yes, with write paths first                                                | Re-sequence: identity before picker        | Agreed: Phase A before Phase B                      |
| Scope calibration       | Add update path, public-leads, search, login                               | Same four, called cherry-picks             | Agreed                                              |
| Alternatives explored   | One helper, no column retirement                                           | Same                                       | Agreed                                              |
| Market/competitive risk | Not the bottleneck today                                                   | Timezone/consent/quiet-hours are           | Outside-only, noted as out of scope                 |
| 6-month trajectory      | Correct foundation                                                         | Picker alone would be cosmetic             | Agreed                                              |
