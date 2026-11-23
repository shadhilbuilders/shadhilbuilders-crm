# Handoff: site update video (steps 7 and 8) - remaining work

Repo: `shadhilbuilders-crm` (Turborepo + pnpm; NestJS backend, Next.js 16 web, Prisma 7,
Postgres with FORCE RLS, Vitest).

Read first, in this order:

1. `AGENTS.md` (repo conventions; the rules below restate only what a handoff needs).
2. `docs/plans/2026-11-23-site-update-video-build-sequence.md` - the plan of record for this
   feature. Step 1-8 sections, then "Known gaps" and "Device gate".
3. `docs/plans/2026-11-23-site-update-video.md` - design + the CEO/eng review history.

## State right now

- Steps 1-6 were committed at `dd475f7`. Steps 7 and 8, the marketing-consent capture and the
  `SITE_UPDATE_WHATSAPP` switch are now COMMITTED on `main` in that order (four commits, then the
  switch). Nothing is pushed: local `main` is ahead of `origin/main`, and pushing is the deploy.
- Backend: 2171 tests green across 121 files. Database: 301 green across 15 files, including
  `consent-rls.test.ts`. Web: 1896 green across 181 files. `tsc` and `eslint` clean in both apps.
- Three migrations are applied to dev and test: `20261123160000_site_update_delivery_no_buyer`,
  `20261123200000_site_update_delivery_no_consent`,
  `20261123193000_site_update_delivery_skipped_disabled`,
  `20261123194500_outbound_message_site_update_delivery`. The Prisma client is regenerated in the
  build and is not committed; run `pnpm --filter @shadhil/database generate` after pulling.

## Do not break these

- Every business query runs inside `withRlsContext()`. `SiteUpdateDelivery` is FORCE RLS with
  staff-gated writes: a bare client insert is refused with 42501. The delivery row is written
  inside the SAME transaction that writes the update, on purpose. (This was a real bug; see the
  step 8 section.)
- Do not run `pnpm format`. The repo's committed style does not match the root config everywhere.
  Format only the files you touched: `pnpm exec prettier --write <file>`.
- The web e2e specs need BOTH servers started with `SITE_VIDEO_CAPTURE=true`, the two storage
  caps set, and `MEDIA_STORAGE=local` (so the inline upload path is exercised and nothing reaches
  the real CDN). The API refuses to boot with the flag on and the caps unset.
- `site-video-flag-off.spec.ts` deliberately SKIPS on a flag-on server. To prove it, restart the
  web server with `SITE_VIDEO_CAPTURE=false`.
- The buyer-facing WhatsApp leg has one switch: `SITE_UPDATE_WHATSAPP=off` stops it for photos and
  video, inside and outside the 24h window, without touching capture. It is checked first in
  `enqueue()`, so nothing is looked up and nothing is queued; the delivery row records
  `SKIPPED_DISABLED`, which keeps the batch visible instead of dropping it. Default is ON.
  Clearing `WA_TEMPLATE_SITE_UPDATE_*` is NOT the switch: that only skips outside-window sends.
- The delivery row's status is advanced by the WORKER, not by the save. `OutboundMessage`
  carries a nullable unique `siteUpdateDeliveryId`; `sendOne` flips that row to SENT (with the
  wamid) or, on the final failed attempt, to FAILED with `errorCode=SEND_FAILED`. A retryable
  failure leaves it PENDING on purpose. The write happens AFTER the outbox row commits and is
  best effort: a failure there logs and leaves the row PENDING, because rolling back a send Meta
  already accepted would message the buyer twice. Runs under CRON_SERVICE, which
  `site_update_delivery_cron_service` already allows.
- A skipped delivery queues no outbox row, so nothing exists to retry. Re-sending a
  `SKIPPED_DISABLED` or `SKIPPED_NO_*` batch is NOT implemented: the row records that it was
  skipped, and a re-send feature would have to rebuild the message from the stored row.

## Task 1 (highest value): capture marketing consent - DONE 2026-11-23

The site-update WhatsApp templates were approved as **MARKETING** (2026-11-23), not the UTILITY
they were submitted as. A consent gate now exists (`site-update-consent.ts`): it reads the newest
`Consent` row for the lead, and a send happens only when `consentType = 'MARKETING'` and
`granted = true`. A lead with NO row is treated as "never asked", which is NOT consent.

**Then: the feature was inert.** No code wrote `Consent` rows, so every outside-window send
recorded `SKIPPED_NO_CONSENT` and the template path had never fired.

**Now: one capture path exists end to end.** Staff record it on the lead.
`POST /api/leads/:id/consent` (`lead-consent.controller.ts`, `lead-consent.service.ts`) appends to
the ledger with a required `source` (`call_verbal`, `in_person`, `whatsapp_button`,
`booking_form` - the panel defaults to `call_verbal`, the API has no default so a caller cannot
claim a provenance it did not choose), writes the audit row in the same transaction, and returns
`{changed, answer, recordedAt}`. Re-recording the answer already on top writes nothing. Lead
detail carries `marketingConsent` + `marketingConsentAt` and the web panel
`lead-marketing-consent.tsx` sits under the lead info card. Tests: service integration
(`lead-consent.test.ts`, real DB), ledger ordering and the three-state read
(`site-update-consent.test.ts`), and a new RLS file `packages/database/test/consent-rls.test.ts`
that proves owner/manager/admin inserts, cross-org and non-owner refusals, and that UPDATE/DELETE
affect zero rows for every role.

Decision recorded in `2026-11-23-site-update-video.md` under "Post-phase-1 owner decisions".

Still not built, and named rather than implied:

- The booking-form checkbox (the CRM has no booking write path this could hang off yet).
- An inbound WhatsApp button reply (needs a quick-reply template approved; the three approved
  ones carry no button).
- Residual RLS note: `consent_insert_admin` requires `organizationId = app.user_org_id` but does
  not require it to equal the lead's org, so an admin of another org can write a row stamped with
  their OWN org against this lead. It is invisible to this org, cannot influence a send here, and
  tightening it is a separate migration.

Do NOT weaken the gate to make sends happen. Skipping is the correct behaviour for an unconsented
lead; sending is what damages the sender number's quality rating.

## Task 2: reconcile `durationMs` - DONE 2026-11-23 (accepted)

The server verifies container, bytes and size, but trusts the client's `durationMs`. **Accepted,
with the reason recorded** in the gap-8 entry of the build sequence and at the check itself
(`site-video.service.ts:196`). The enforceable limits are elsewhere and cannot be lied past: 14MiB
against the stored object, `1..45s` as a DB CHECK, the recorder's own 45s stop. Reading `mvhd` was
rejected because Chrome records fragmented MP4, where `mvhd` duration is commonly 0 - a probe would
guess, and a wrong probe refuses a valid clip.

## Task 3: commit - DONE 2026-11-23

Landed on local `main`, in this order, after "start but don't commit" was lifted:

1. `1241242` feat(web): record and play site-update video (step 7) - 62 files;
2. `d0605a1` feat(progress): send site updates to the buyer over WhatsApp (step 8) - 26 files;
3. `58208df` feat(leads): record marketing consent on the consent ledger - 12 files;
4. `8a9e553` fix(web): keep the query string through login, and close the plan's open gaps - 6 files.

Then the switch, as its own commit. Not pushed: pushing main is the deploy, and that is a separate
decision. Split boundaries followed dependencies rather than filenames - `SitePhotoFeed.tsx` went
with step 7 because the capture view and two staged tests import `SitePhotoCard` from it, and
consent came after delivery because the capture service imports the gate delivery introduced.

## Task 4: needs hardware, cannot be done in CI

The device gate (five rows, in the plan under "Device gate before the flag flips") has never been
run: no real phone, no Safari, no throttled 3G, no WhatsApp in-app browser. Only a fake camera has
been exercised. This is also the only place the AAC-when-audio-on case can be proven - the dev
Chromium reports `avc1` as supported but `avc1,mp4a.40.2` as NOT, and records a silent clip when
asked for audio anyway (which is why `supportsAudio()` gates the toggle).

If a real device becomes available, ffprobe the produced file: expect h264 Baseline or Main, no
B-frames, AAC when audio is on, moov before mdat.

## Task 5: unproven network path (needs a real Meta account)

No site-update message has ever been delivered: the templates are approved but the sender is still
a Meta test number, and a MARKETING template is ACCEPTED by the API then SILENTLY DROPPED in that
state. An outside-window `131047` refusal is also unexercised.

## Useful commands

```
pnpm --filter @shadhil/backend test          # unit + integration
pnpm --filter @shadhil/web test
pnpm --filter @shadhil/database test         # RLS matrix
bash packages/database/scripts/reset-test-db.sh   # reset shadhil_crm_test
cd apps/web && pnpm exec playwright test src/test/e2e/site-video.spec.ts --project=chromium
```

## Key files for this feature

Backend (`apps/backend/src/customer-progress/`):

- `site-update-delivery.service.ts` - the whole send decision (`planDelivery` is pure).
- `site-update-delivery.provider.ts` - Nest wiring; dependencies optional on purpose.
- `site-update-consent.ts` - the MARKETING gate (Task 1).
- `site-update-greeting.ts` - first name or the neutral `there`.
- `site-update-villa.ts` - `A-101 (plot 37)`, plot folded into the villa value.
- `site-update-link.ts` - the portal deep link + origin resolution.
- `site-video.service.ts` / `site-video.controller.ts` - upload-auth, record, cancel.
- `progress-photo.mapper.ts` - `mediaUrl` is the poster; `whatsappStatus` for staff only.

Backend (`apps/backend/src/leads/`):

- `lead-consent.controller.ts` - `POST /leads/:id/consent`.
- `lead-consent.service.ts` - the append-only ledger write + audit, `changed: false` on a repeat.
- `leads.service.ts` (`findOne`) - carries `marketingConsent` / `marketingConsentAt`.

Web:

- `apps/web/src/components/leads/lead-marketing-consent.tsx` - the panel + record dialog.
- `apps/web/src/hooks/queries/crm.ts` (`useRecordLeadConsent`) - the mutation.
- `apps/web/src/components/site/SiteRecorder.tsx` - opens on `idle`; Record starts the camera.
- `apps/web/src/lib/site-video/` - recorder engine, reducer, uploader, poster, errors.
- `apps/web/src/proxy.ts` - login redirect preserves the query string (a WhatsApp link depends on it).
- `apps/web/src/test/e2e/site-video.spec.ts` and `site-video-flag-off.spec.ts`.
