# Site update video: build sequence

One page an engineer can follow. The plan (`2026-11-23-site-update-video.md`) is the authority on behaviour; the design (`2026-11-23-site-update-video-design.md`) and mockup (`site-update-video-mockup.html`) are the authority on what it looks like. Nothing here is implemented yet.

## How to read the plan

The plan carries one record per review phase, and the earlier records were written before the later reviews corrected them. Where they disagree, the later phase wins and the body is current. These six lines in the earlier records are superseded, and this table is the only place that says so:

| Earlier record says                             | Current decision                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "audio off permanently with no AAC anywhere"    | visible per-clip toggle, default off, `hasAudio` recorded, microphone permitted on the site route                         |
| "a checked-in WebM fixture"                     | fixtures are MP4; WebM is refused by the sniffer and the recorder forces MP4                                              |
| "no Meta `/media` call in the client, new code" | `uploadMedia()` and `sendMediaMessage()` already exist; the missing piece is a video template header                      |
| "`pnpm --filter @shadhil/database migrate:dev`" | `migrate`, and `cd packages/database && npx prisma migrate deploy` for production                                         |
| "`lastPhotoStage` is removed"                   | kept as an alias until the UI step, because sixteen readers exist                                                         |
| "BFF passes through with `redirect: 'manual'`"  | redirects are followed server-side; a Location to a signed URL must never reach the browser                               |
| "`video/mp4;codecs=avc1`"                       | `avc1.42E01E` plus `mp4a.40.2`, pinned after Meta's docs showed High profile with B-frames is refused on Android WhatsApp |

## Measured before any code (done 2026-11-23)

Both unknowns are now answered, with numbers rather than assumptions.

**1. ImageKit private video and Range: works, with one trap.**

On a 13.61 MB (14,268,660 byte) private upload:

```
unsigned bare URL            403, 25 bytes
signed URL, no range         200, accept-ranges: bytes
signed URL, Range 1000-2000  206, content-range: bytes 1000-2000/14268660, 1001 bytes
signed URL, Range 5000000-   206, content-range: bytes 5000000-6159487/6159488
signed URL, HEAD             200, length, accept-ranges: bytes
```

The trap is size: the plain signed URL served 6,159,488 bytes for a 14,268,660 byte upload, because ImageKit re-encodes video on delivery unless asked for the original. The repo's current reader appends `?tr=orig-true` by string concatenation, and that now fails: appending it, or any extra query parameter, to a signed URL returns **403**, because `ik-s` signs the whole URL including its query string.

The working form is to sign a URL that already carries the transformation:

```ts
ik.url({
  path: filePath,
  signed: true,
  expireSeconds: 600,
  transformation: [{ raw: 'orig-true' }],
});
```

That served exactly 14,268,660 bytes, `accept-ranges: bytes`, and still answered `206` with the right `content-range`. So step 2 builds the signed URL with the transformation inside it and never mutates the URL afterwards. As written in the plan, private video would have 403'd on every read.

**2. Meta video ceiling: 16 MB, and a codec constraint we would have failed.**

From Meta's own docs (video messages, updated 2026-05-21, and the media reference, updated 2026-10-30): video maximum **16 MB**, **H.264 and AAC only**, single audio stream or no audio stream.

Our 14MiB cap sits under 16 MB, so the byte ceiling does not move. The codec note does change step 7: Meta states that **H.264 "High" profile with B-frames is not supported by Android WhatsApp clients**, and recommends Main or Baseline without B-frames, with the moov box before mdat. ffmpeg's default `libx264` is High with B-frames, and the probe file confirms it: `profile: High`. That is precisely the file Android WhatsApp refuses.

So the recorder must pin the codecs rather than accept the browser default:

```
video/mp4;codecs="avc1.42E01E,mp4a.40.2"   // Baseline + AAC-LC when audio is on
video/mp4;codecs="avc1.42E01E"             // Baseline, no audio
```

and step 7 proves the produced file with ffprobe before the flag flips: profile Baseline or Main, no B-frames, AAC when audio is enabled, moov before mdat.

A 45 second clip at 2.5 Mbps measured 13.61 MB, which is 13.0 MiB, so the 14MiB cap has real headroom on both limits.

## Steps, each green on its own

| #   | Step                                                                                                                                                                                                                                                                                                                                      | Proof it is done                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Schema and RLS in one migration: `kind`, nullable `key`, `sizeBytes`, `durationMs`, `posterKey`, `batchId`, `uploadId`, `archivedAt`, `hasAudio`, `Unit.handoverCompletedAt`, quoted-camelCase CHECKs, concurrent unique indexes, `StorageUsage` and `SiteUpdateDelivery` with grant, enable, force RLS, member policies and the cron arm | `pnpm --filter @shadhil/database test` plus an RLS case proving a non-member insert is denied and a cron claim succeeds; web typecheck still green because `lastPhotoStage` survived                                    |
| 2   | Provider seam: `stat`, `readStream` returning `{status, headers, body}`, `createUploadAuth`, and signed reads that carry `tr=orig-true` **inside** the signature, local-disk implementation                                                                                                                                               | existing media tests green; a private object returns its full stored byte count through the provider, answers 206 to a range request, and 403s at its bare CDN URL                                                      |
| 3   | `sniffMime` narrowing: brand allowlist to `video/mp4`, `qt  ` to `video/quicktime`, EBML to null                                                                                                                                                                                                                                          | `pnpm --filter @shadhil/backend test sniff-mime` with the three fixtures                                                                                                                                                |
| 4   | `UnitUpdateSummary` behind existing call sites, alias populated                                                                                                                                                                                                                                                                           | web typecheck and the units-grid tests green with no visual change                                                                                                                                                      |
| 5   | Routes: upload-auth, record, cancel, coded errors with `retryable`, `deletePhoto` deleting both keys, **poster generated client-side and uploaded private through the same signed folder**, **mapper `mediaUrl` returns the poster for video rows**                                                                                       | one service test per code; a delete test asserting two storage deletes; a video row whose `mediaUrl` is its poster, not its clip; a public poster rejected like a public clip                                           |
| 6   | BFF: regression suite first (JSON POST, 204, HEAD, PDF), then streaming with `Range` in and 206 out                                                                                                                                                                                                                                       | the suite green before the change (204 is broken today, so this step fixes it) and a 206 asserted through `/api/bff/media/...`                                                                                          |
| 7   | UI: recorder with pinned codecs, picker, tiles, lightbox, server-wrapper flag, delete the `lastPhotoStage` alias in the commit that kills its last reader (done: alias deleted, readers on `lastRecordedStage`)                                                                                                                           | the design's `data-qa` inventory in the DOM; Playwright records, seeks and sees 206; denied camera falls back; ffprobe on the recorded file shows Baseline or Main, no B-frames, AAC when audio is on, moov before mdat |
| 8   | WhatsApp: `SiteUpdateDelivery` writes, deep-link send that survives a signed-out buyer, staff status                                                                                                                                                                                                                                      | window closed sends the template path; no template is `SKIPPED_WINDOW`, not a silent drop                                                                                                                               |

Steps 1 to 4 change no behaviour a user can see. That is deliberate: the risky structural work lands before any pixel moves.

## Step 1: landed 2026-11-23

One migration, one test file, two small service edits.

`20261123120000_progress_photo_video` carries the schema as planned: `kind` (enum, default PHOTO, no backfill), `key` widened to nullable, the six video columns, `Unit.handoverCompletedAt`, four CHECK constraints added NOT VALID and validated in the same file, three indexes, and `StorageUsage` + `SiteUpdateDelivery` with GRANT, ENABLE, FORCE RLS and policies. The indexes are plain `CREATE UNIQUE INDEX`, not `CONCURRENTLY`: Prisma Migrate wraps a migration in one transaction and `CONCURRENTLY` cannot run inside one. The repo already made that call in `20261118120000_user_phone_partial_unique`, and 13 rows do not justify splitting the file.

The write policies are staff-role gated, and that is a correction caught while this was still uncommitted. Write arms that checked only the organisation let a CUSTOMER login advance `StorageUsage.usedBytes` - and that ledger is what enforces the per-org cap, so a buyer could hand themselves unlimited storage - and let the same buyer mark a WhatsApp delivery SENT. The portal migration already stated the rule it broke: no write arm exists for CUSTOMER on any table. Writes to both new tables now name the staff roles; reads stay org-scoped. The GUC-only service markers appear in no staff list, so a forged `CRON_SERVICE` role carrying a real user id reaches neither a staff arm nor the sentinel-checked cron arm.

`packages/database/test/site-update-video-rls.test.ts` is the proof, 22 cases: every CHECK rejects its half-written row and accepts the boundary case, `kind` still defaults to PHOTO, a member reads and advances the ledger while another org sees nothing, a CUSTOMER is denied write access to both tables, the cron pair claims a PENDING row and a forged role with a real user id is denied, an engineer writes only their own villa's delivery row, and MANAGER cannot delete a batch ADMIN can.

The non-test code changes are `assertPhotoMutable` returning `key: string | null` and `deletePhoto` skipping the storage call when a tombstone has no key left; the mapper's `mediaUrl` returns an empty string for such a row, which no live row can reach. `lastPhotoStage` is untouched, which is what keeps the web typecheck green.

Verified: `pnpm --filter @shadhil/database test` 286 passed across 14 files, backend 1906 passed across 103 files, web 1519 passed across 148 files, backend and web typecheck clean, backend lint clean.

## Step 2: landed 2026-11-23

The provider seam, with no route change.

`StorageProvider` gains `stat(key)`, `readStream(key, range?)` and an optional `createUploadAuth(req)`, with `UploadAuth` as the discriminated `direct | inline` union. `stat` and `readStream` return null for a missing key rather than throwing. `readStream` reports `206`, `416` (null body) or `200`, and a `200` answer to a ranged request stays a `200`: it is not relabelled.

`ImageKitStorage` now builds every read URL once through `signedOriginalUrl()`: `imagekit.url({ signed: true, expireSeconds: 600, transformation: [{ raw: 'orig-true' }] })`. The real SDK places the transformation in the **path** (`/tr:orig-true/<key>`), not the query string, and the query carries only `ik-s` and `ik-t`. That is the form measured against the live CDN, and `imagekit-signing.test.ts` pins it against the real SDK with no mock. `read()` uses the same URL, so whole-file consumers (the outbound Meta upload) can read a private object; signing a public object's URL is harmless. Existing behaviour is pinned: the one assertion that expected `?tr=orig-true` appended now expects the signed URL, and every other media test is untouched.

`stat` uses the list API's exact-path match (as `delete` does) and treats a missing `isPrivateFile` as **public**, because the record route refuses a public clip and the safe reading of a gap is the one that refuses.

Gap 4 is closed with a number: local `createUploadAuth` returns `{ transport: 'inline', maxBytes }` carrying `MAX_VIDEO_BYTES = 14,680,064`, the same figure as the `ProgressPhoto_size_cap` CHECK. Base64 of that is about 19.6MB of JSON, inside the 25MB both hops allow, so a real 13.6MB clip uploads in dev.

Verified: storage suite 107 passed across 8 files, backend typecheck and `eslint src/storage` clean. **Not verified:** the live-CDN rows of the proof (a private object served at full byte count, 206 on Range, 403 at the bare URL) were measured earlier with the same `ik.url` call and are not re-run in CI, since that needs real credentials.

## Step 3: landed 2026-11-23

`sniffMime` no longer falls through to `video/mp4` for an unnamed `ftyp` brand. HEIC and AVIF are still matched first; `qt  ` returns the new `video/quicktime`; a 16-brand allowlist (ISO generations, `mp41`/`mp42`, `avc1`, `dash`, `M4V `, the 3GPP family) returns `video/mp4`; an EBML header returns null on purpose so WebM is refused rather than guessed; any other brand returns null. The fixtures are header buffers in `sniff-mime.test.ts` (MP4, QuickTime, EBML, plus the refused `M4A `); a real recorded MP4 arrives in step 7 for the ffprobe proof.

One behaviour change to know about: an audio-only `M4A ` file used to be labelled `video/mp4` and is now unidentified, so `reconcileUploadMime` returns null for it and the chat upload route answers 400. No test pinned the old labelling, and a voice note called video was a bug, but if chat is meant to accept `.m4a`, add `M4A ` as an audio type in a follow-up rather than putting it back in the video list.

Verified: backend 1943 passed across 105 files, typecheck clean.

## Step 4: landed 2026-11-23

`UnitUpdateSummary` is split in two, and the plan's "two filtered `take: 1` relations" turned out not to be buildable: Prisma selects a relation once per query, and the grid needs it three ways.

- **Legacy fields stay in `UNIT_ROW_SELECT`, filtered to PHOTO.** `lastPhotoAt`, `photoCount` and the `lastPhotoStage` alias still come from the row, now with `where: { kind: 'PHOTO' }` on both the take-1 relation and the filtered `_count`, so a clip can never become "the newest photo" or inflate the photo count. For photo-only data the output is identical.
- **The video-aware fields come from `unit-update-summary.ts`**: `videoCount`, `updateCount`, `lastUpdateAt`, `lastRecordedStage`, `lastRecordedStageAt`. `loadUnitUpdateExtras` runs two statements for a whole page, one `groupBy(unitId, kind)` and one `DISTINCT ON ("unitId")` over rows `WHERE stage IS NOT NULL`, on the caller's RLS transaction. It is wired into the units list, the unit detail read and the site units list.

Two decisions to know about. The new `UnitRow` fields are **optional on the wire and omitted, not zero,** when a surface did not load them (create, update, assign, the plot map), so an unloaded count cannot be read as an empty feed. And `lastPhotoStage` keeps its old meaning (newest PHOTO's stage) rather than becoming an alias of `lastRecordedStage` today: aliasing them would change what a photo-only unit shows when its newest photo has no stage but an older one does, and step 4 promised no visible change. Step 7 moves the readers to `lastRecordedStage` and deletes the alias.

The query was run against live Postgres in a throwaway test (not committed): a unit with a STRUCTURE photo and a newer stageless video returned `videoCount 1`, `updateCount 2`, `lastRecordedStage STRUCTURE` dated the photo, and `lastUpdateAt` dated the clip. The committed tests prove the fold, the two-statement call shape and the PHOTO filters, with mocks; there is no committed DB-backed proof of the SQL text.

Verified: backend typecheck clean; inventory and customer-progress suites green.

## Step 5: landed 2026-11-23

Routes (all 404 `VIDEO_CAPTURE_DISABLED` while `SITE_VIDEO_CAPTURE` is off):
`POST customer-progress/units/:unitId/videos/upload-auth`, `.../videos/uploads/:uploadId`
(local-disk transport), `POST .../videos` (201, or 200 on replay), and
`DELETE .../videos/pending/:uploadId`.

Decisions made while building:

- **Per-project cap and rate limit, from config only.** `SITE_VIDEO_ORG_CAP_BYTES` and
  `SITE_VIDEO_PROJECT_CAP_BYTES` are required when the flag is on; boot fails without them.
  Grant limits default to 20 per user, 100 per project, per 600 s. Documented in `.env.example`.
  A user over their own limit does not consume the project allowance.
- **Ledgers.** `StorageUsage` (org) and `ProjectStorageUsage` (project) are charged by a
  conditional UPDATE in the record transaction, org row first. Only clip bytes are counted;
  posters are small and uncounted. `deletePhoto` credits both in the same transaction.
- **Upload ids are server-issued**: nonce plus HMAC over (org, unit, user), keyed from
  `JWT_SECRET`. Keys must sit in `<org>/<uploadId>/` with fixed filenames.
- **`durationMs` is trusted** (range-checked 1-45 s only). Size, privacy and container come from
  storage, never from the client.
- **Cleanup rule.** A client-fault refusal discards the upload folder. An infrastructure failure
  deletes nothing, so a retry reuses the blobs. Record, cancel and discard take a per-upload
  advisory lock, and record re-checks the clip inside the lock, so a cancel cannot leave a row over
  deleted blobs. After a take is recorded, inline re-upload to its folder is refused.
- **`policies.sql`** carried an error in the step 1 block; fixed in the step 5c block.
- The buyer push and the staff notifier are NOT wired for videos (private to
  `CustomerProgressService`). Left for steps 7/8.

Security review follow-ups, not done: upload ids never expire and derive from `JWT_SECRET`
(M2); a direct ImageKit grant does not enforce size or folder, so orphan folders need a sweeper
(M4); only the `ftyp` header is sniffed and `durationMs`/`hasAudio`/`takenAt` are trusted (M5);
inline upload has no per-request rate limit (M1, body now bounded by schema). Review's H3 (OWNER
missing from RLS) is not a defect: OWNER travels as ADMIN at the RLS layer.

Known gaps 1, 2, 3, 5 and 8 are closed or decided by the above.

## Step 6: landed 2026-11-23

- **Suite first.** `apps/web/src/app/api/bff/[...path]/route.test.ts` (auth gate, JSON POST,
  error passthrough, non-ASCII, 204, empty 200, PDF bytes, encoded media key, HEAD) was run
  against the unchanged proxy: 8 green, 2 red. The two reds were real defects, not test
  mistakes: a 204 threw (`Response` constructor rejects a body on 204) and there was no `HEAD`
  export. Both are fixed by the change.
- **Streaming.** The proxy no longer buffers: `Range` and `If-Range` go up, the upstream body is
  relayed as a stream, and `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified` and
  `Content-Disposition` come back. `Cache-Control` stays `no-store`. `Content-Length` is relayed
  only for identity encoding. The browser's abort signal is passed upstream, so a seek cancels
  the old read. `route.range.test.ts` covers this.
- **Backend media route.** It had no Range support, so the 206 could not exist. `.mp4` keys now
  stream through `readStream` with `parseRangeHeader` (single `bytes=` ranges, including `0-`
  and suffix `-N`; multi-range or malformed headers are ignored and get a full 200). Access
  (`assertReadable`) runs before any byte is read. Every other key keeps the buffered, sniffed
  path, so images and PDFs are unchanged. Content-Type is `video/mp4` because `record` already
  verified the container.
- **Not covered here:** a live 206 end to end through a running web + API pair. That is the
  Playwright check in step 7.

## Step 7: built 2026-11-23 (uncommitted)

Landed in the working tree, all behind `SITE_VIDEO_CAPTURE` (server wrapper `page.tsx` passes
`videoEnabled`; flag off renders the photo-only bar, asserted by test):

- `ApiError.retryable`; `lib/site-video/*`: error copy, recorder reducer, codec/camera support,
  poster (always a JPEG, placeholder on failure), uploader with session reuse on Retry,
  `RecorderEngine` (releases every track; 45 s ceiling; sub-second take discarded), gallery file
  validation (MP4 brand only, size, 1-45 s), flag reader.
- `SiteRecorder` sheet (record, review with stage and caption, upload progress from real bytes,
  Retry only for server-flagged retryable errors, camera-denied fallback to the picker),
  Video target in the capture bar, video tile (poster, play glyph, duration, "Video, N seconds"),
  lightbox player (no autoplay, `preload="none"`, download fallback), empty-state copy.
- Permissions-Policy `camera=(self), microphone=(self)` on the site routes only.

Deviations from the design table, deliberate: permission states are an inline panel, not an
`AlertDialog`; the caption is the library `Textarea` like the photo note dialog, not `InputGroup`;
the gallery video goes through a hidden `accept="video/mp4"` input rather than the overflow menu,
so the existing Gallery button and its markers are untouched.

Done since: the Playwright run (`apps/web/src/test/e2e/site-video.spec.ts`: record with a fake
camera, save, 200 and 206 through the BFF, ffprobe h264 Baseline/Main with no B-frames, no audio
track, moov before mdat, camera denied falls back to the picker). It caught a real bug: the
per-upload advisory lock used `$queryRaw` on a `void` column, which Prisma's adapter cannot read,
so every record returned 503; now `$executeRaw`. The buyer portal hero, list thumbnails and
lightbox show a clip as its poster with a play cue and play it in the lightbox
(`portal-video.test.tsx`). The 8-photos/1-video cap needs no new code: a clip is saved one per
recorder session and the photo note keeps its own cap of 8, so the two never mix.

Also done since. The `lastPhotoStage` alias is GONE: every reader moved to
`lastRecordedStage` (the newest row of ANY kind that recorded a stage), and the four surfaces that
built a row without the summary - unit create, unit update, the assignment read-back - now load
it, so no screen lost its stage. `plots()` deliberately does not: the plot map never reads a stage.
The audio toggle was UNREACHABLE: the sheet auto-started the camera on open, so the `idle` state
that owns the switch and the Record button never rendered, and a MediaRecorder's tracks are fixed
once it starts anyway. The sheet now opens on `idle`; Record starts the camera. Measured on this
build's Chromium 2026-11-23: `video/mp4;codecs=avc1` is supported, `avc1,mp4a.40.2` is NOT, and
asking for audio anyway records a SILENT clip with an Opus track. So `supportsAudio()` gates the
switch on the AAC-muxing type: where it cannot mux, the screen says "Audio unavailable" and never
asks for a microphone. The iPhone `.mov` refusal now says what to do about it
("iPhone videos are HEVC. Record it in the app, or export it as MP4 first."), in the client and
the server, and the route is `force-dynamic`, so the flag does not bake at build time.

Not done: the device gate. Only a fake camera has been exercised, so every row of the table below
is still unproven: no real MP4 from a phone, no Safari, no throttled 3G, no WhatsApp in-app
browser. The AAC-when-audio-on ffprobe assertion exists and runs, but no device here can produce
that file; it needs an Android Chrome or iPhone Safari run.

## Step 8: built 2026-11-23 (uncommitted)

The buyer-facing WhatsApp leg, on top of the existing outbox rather than a second Meta client.

`site-update-delivery.service.ts` decides what to send, in a pure `planDelivery()` that a test
drives without a DB, network or clock: inside the 24h window freeform media is allowed, outside it
only an approved template is, and with no template configured the row is `SKIPPED_NO_TEMPLATE`
instead of a guaranteed Meta refusal. A non-MP4 clip is never sent as a video: it goes as its
poster, which is exactly why step 5 made the poster mandatory. The decision inputs are the buyer's
last inbound (the same `isServiceWindowOpen` the chat composer uses), the row's recorded
`mimeType`, and the storage `stat` for a purged clip.

ONE MESSAGE PER BATCH, not per row. The delivery row's unique `(organizationId, batchId)` is the
guard, and a unique violation is treated as "already recorded" rather than pre-checked - a
pre-check loses the race when six photos are saved in one note. Photos carry no `batchId` on the
wire, so the batch is the capture instant (`photo-<takenAt>`), which the six rows of one note
share.

TWO BUGS THE RUNTIME RUN CAUGHT, both invisible to unit tests:

1. **The row could not be written at all.** The first version used the bare Prisma client, and
   `SiteUpdateDelivery` is FORCE ROW LEVEL SECURITY with staff-gated writes, so every insert was
   refused with 42501. The delivery write now runs inside the SAME `withRlsContext` transaction
   that writes the update, which also means a message is never queued about a row that rolled
   back. Verified end to end: a recorded clip now leaves a delivery row behind.
2. **"No buyer" was recorded as FAILED.** The e2e unit has no booking, so the row said delivery
   failed - sending support after a phantom bug. The enum gained `SKIPPED_NO_BUYER` (migration
   `20261123160000_site_update_delivery_no_buyer`), and the staff row says "Not sent: no buyer on
   this unit".

The deep link (gap 6) is `site-update-link.ts`: `<web origin>/portal?unit=&photo=`, built with the
SAME origin resolution as invite links so it cannot point at the API host. A signed-out buyer is
bounced to `/login?next=<path>`, and `isSafeNextPath` accepts only same-origin absolute paths, so
they land back on the update. Ids are URL-encoded, so one cannot smuggle a second parameter. No
origin configured means the message goes out WITHOUT a link and the log names the variable; it
never emits a relative link.

Staff status is on the row: the timeline DTO gains `whatsappStatus` for a staff viewer only (one
batched query per page), and the feed renders it in words ("Sent to buyer", "Not sent: buyer
window closed"), never as an enum. Null - buyer view, pre-step-8 row, no delivery row - renders
nothing rather than an ambiguous "not sent".

Meta fetches template media itself, so `StorageProvider` gained `shareUrl(key)`: a signed,
short-lived URL (ImageKit's `signedOriginalUrl`, the same one `read`/`readStream` use) minted at
SEND time from the row's own `mediaKey` and never stored. `WhatsAppClient`'s template header type
now covers video and image, not just documents.

TWO templates, not one. Meta fixes a template's HEADER TYPE at approval, so a VIDEO-header
template rejects an image parameter and vice versa - one name could never serve both a clip and a
poster. `WA_TEMPLATE_SITE_UPDATE_VIDEO` and `WA_TEMPLATE_SITE_UPDATE_IMAGE` are chosen by what the
send actually has, and a blank variable means "not approved yet" (`SKIPPED_NO_TEMPLATE`), never a
doomed call. The template path also had no link until now: the URL button is
`/portal?photo={{1}}` (Meta allows one variable, and it must end the URL), sent as its own
component carrying the row id. It is opt-in per template name (`hasUrlButton`), because a button
component sent to a body-only template is a Meta 132000. The portal already resolves the unit from
the photo id.

The body greets by FIRST NAME (owner decision 2026-11-23). A template parameter can never be
omitted - Meta validates the count before it reads the text - so "send it without the name" is not
expressible: the slot always carries a string, and a neutral fallback is a greeting that still
reads (`Hello {{1}},` with "Asha", or "there"). `greetingName()` takes the first word and refuses
anything that is not plainly a name (titles like "Sir", digits, emails, initials, empty), because
`Lead.name` is whatever a staff member typed. The freeform path uses the same opening, so a buyer
who gets one of each does not see two different companies. The engineer's note is body variable
`{{3}}`, with a neutral line when empty, so the template never needs re-approving for it.

Body and button variables share one row object, which exposed a real bug: the old code stringified
EVERY key as a body parameter, so the button's `photo` value would have been a fourth body
parameter against a three-variable template (Meta 132000). `bodyVars()` now sends numbered keys
only; named keys travel in their own component.

The PLOT NUMBER travels inside the villa value (owner decision 2026-11-23), not as a fourth slot:
`Unit.plotNumber` is nullable and a template parameter can never be omitted, so a "plot {{n}}" slot
would print "plot " or "plot null" for a villa entered before it was placed on the layout.
`villaLabel()` yields `A-101 (plot 37)`, or `A-101` alone, so ONE approved template covers both and
the wording can change later without a re-approval.

An empty note is NOT an empty message. The web client omits `caption`, and the server then GENERATES
one (`Phase A November 2026`) for the timeline, so `caption` is never blank downstream - which meant
the note slot would have quoted that date stamp to the buyer as if the engineer had written it. The
row keeps the generated caption (it is a fine timeline title); the delivery now receives
`hasNote: false` and says "Your site team has posted a new update." instead, on both the template and
the freeform path.

APPROVED AS **MARKETING**, not the UTILITY it was submitted as (2026-11-23). Two consequences, both
handled rather than discovered in production. Each delivered template is billed (the freeform path
inside the 24h window stays free). And Meta requires marketing opt-in, so `site-update-consent.ts`
reads the newest `Consent` row for the lead: granted sends, denied and NEVER-ASKED both skip with
`SKIPPED_NO_CONSENT`. "Never asked" deliberately does not read as yes - that is the population most
likely to complain, and complaints are what damage the sender number's quality rating. The gate
applies to the template path only, because a freeform reply in the window is not marketing.
Migrations `20261123160000` and `20261123200000` add `SKIPPED_NO_BUYER` and `SKIPPED_NO_CONSENT`.

Not done, and each needs a real Meta account to prove: the two site-update templates are awaiting
approval (names are in `.env.example`), nothing exercises a real 131047 refusal, and the freeform
media-plus-link message has not been sent to a phone. The unit tests cover the decisions; the
network path is proven only as far as the outbox row.

## Known gaps: ten items, checked before the flag flips

Found by auditing the plan against the code after the gate closed. Items 1 to 4 block step 5 as written; the rest are named risks with a decision attached rather than silent assumptions.

- [x] **1. Poster production is specified and built. (closed in step 5)** `poster.ts` grabs a frame, `toBlob('image/jpeg', 0.8)`, and a grey placeholder is uploaded when no frame scores - so a failed poster never blocks the save. **Step 5.** (was: Poster production is unspecified. Nothing in the current body says how the frame is made, yet the CHECK makes `posterKey` mandatory for a live video. Fix: canvas grab at about one second, `toBlob('image/jpeg', 0.8)`, max 1280px wide, fall back to the first decodable frame, and a failed poster never blocks the save. **Step 5.**
- [x] **2. The poster lands private. (closed in step 5)** `verifyPoster` refuses any object whose `stat().isPrivate` is false, exactly like the clip (`site-video-verify.ts:86`). **Step 5.** (was: The poster would land public. Images go through `/api/media` base64, which stores them public, leaking exactly the frame the private-video decision protects. Fix: the poster uploads private through the same signed folder and the record route verifies both objects. **Step 5.**
- [x] **3. `mediaUrl` is the poster. (closed in step 5)** `imageUrlFor` returns `posterKey` for a VIDEO row and `key` otherwise (`progress-photo.mapper.ts:186-189`). **Step 5.** (was: `mediaUrl` points at the clip. `progress-photo.mapper.ts:165` is `mediaUrlFor(row.key)`, so a video row renders its MP4 into every `<img>`. Fix: `kind === 'VIDEO' ? mediaUrlFor(posterKey) : mediaUrlFor(key)`, with a mapper test using a video row. **Step 5.**
- [x] **4. Local dev cannot upload a real clip. (closed in step 2)** `createUploadAuth` returns `{transport:'inline', maxBytes}` with no number, against a 13.6MB clip and a historical 8MB inline ceiling. Fix: name the number, either 16MB inline for local or a short dev fixture, and say which. **Steps 2 and 7.**
- [x] **5. `upload-auth` is throttled. (closed in step 5)** `uploadAuth` calls `limiter.consume({organizationId, userId, projectId})` before issuing any grant, and the limiter fails closed. **Step 5.** (was: `upload-auth` is unthrottled. `ThrottlerModule` is imported only in `users.module.ts:12`, not globally, and each token is reusable for 600s. Fix: throttle the route, or record the acceptance in the plan's decision table. **Step 5.**
- [x] **6. The deep link's return path has no mechanism. (closed in step 8)** The link is `<web origin>/portal?unit=&photo=` and a signed-out buyer is bounced by the proxy to `/login?next=<path>`, where `isSafeNextPath` accepts only same-origin absolute paths - so the target travels in `next` and an open redirect is refused. `site-update-link.ts` reuses the invite link's origin resolution. **Step 8.**
- [x] **7. iPhone library clips always fail. (closed in step 7)** A Photos recording is `.mov`, refused by design, so iOS supports in-app recording only. The refusal now names HEVC and says "Record it in the app, or export it as MP4 first.", in `errors.ts` and `site-video.errors.ts`. The device gate row still has to be run on a real iPhone. **Step 7.**
- [x] **8. The server trusts `durationMs`. (accepted 2026-11-23)** Container, bytes and size are verified; `durationMs` is not, so a client could claim 20s for a 45s clip. **Decision: accept it, with the reason on the record.** The real limits are enforced where a lie cannot reach them - the 14MiB cap is checked against the stored object, `1..45s` is a DB CHECK, and the recorder stops at 45s - while `durationMs` is display metadata on a timeline tile. Reading `mvhd` from the first range read was rejected on evidence: Chrome records fragmented MP4, where `mvhd` duration is commonly 0 and the real timing is in the fragments, so a probe would have to guess and a wrong probe refuses a valid clip. Comment at the check in `site-video.service.ts:196`. **Step 5.** (was: The server trusts `durationMs`. Container and bytes are verified, duration is not, so a client can claim 20s for a 45s clip. Fix: accept it and record the decision, or read the `mvhd` duration from the first range read. **Step 5.**)
- [x] **9. The flag needs a dynamic page. (closed in step 7)** `site/[unitId]/page.tsx` exports `dynamic = 'force-dynamic'`, so the flag is read per request and cannot bake at build time. **Step 7.**
- [x] **10. No flag-off test. (closed in step 7)** `site-video-flag-off.spec.ts` asserts the photo-only screen (no Video target, no hidden video input, no recorder) and reads `videoEnabled` out of the rendered payload, so on a flag-on server it SKIPS instead of failing for the wrong reason. Verified both ways: it passes against a server started with `SITE_VIDEO_CAPTURE=false` and skips against one started with `true`. **Step 7.**

## Order that is not negotiable

- Schema before anything reads `posterKey`.
- Signing before any private read, and therefore before step 8.
- The BFF regression suite before the BFF change.
- `lastPhotoStage` deleted in the same commit as its last reader, never earlier.

## What is deliberately not here

Public clips, WebM capture, transcoding, codec probing beyond the container, more than one clip per note, trimming, overlays, per-user quotas, Sentry or a dashboard, migrating existing photos, converting the photo routes' error shape, and Meta template approval itself. Each is a later, separate decision.

## Device gate before the flag flips

| Device                                | Pass criteria                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Android mid-range, Android 13, Chrome | record starts under 1.5s; 20s clip uploads on throttled 3G within 90s; playback starts under 3s; seek works |
| Android low-end, Android 11, Chrome   | same, upload within 120s, survives backgrounding mid-upload                                                 |
| iPhone, current iOS, Safari           | same; MP4 recording works; permission denial recovers without a reload                                      |
| iPhone, previous iOS, Safari          | same                                                                                                        |
| Buyer, WhatsApp in-app browser        | portal opens from the deep link, clip plays, no download prompt                                             |

Each row needs an artefact and a named owner. A row without an artefact did not pass.

Status 2026-11-26: rows 1, 2 and 5 were run in an emulated browser and the numbers are in
`docs/plans/2026-11-26-device-gate-run.md` and `docs/plans/artefacts/device-gate-results.json`.
Row 1 passes every bar. Row 2 passes record start and upload and MISSES playback, twice: 6.46s
and 9.50s against a 3s bar, with the CPU throttled 4x. Rows 3 and 4 did not run at all: WebKit will
not launch on this host and iOS Safari cannot be emulated. Row 5's player was proved under a
WhatsApp user agent but not the buyer's session. No row is signed off, because none of them was
taken on a phone.

## The five things most likely to go wrong

1. **The recorder produces a container the pipeline or Meta refuses.** Chrome may ignore the MP4 hint and record WebM, or honour MP4 but emit H.264 High with B-frames, which Android WhatsApp cannot play. `isTypeSupported` answering yes is not proof; ffprobe the actual file on the mid-range Android in step 7.
2. **The direct upload is accepted publicly.** The signature does not cover `isPrivateFile`, so the server check in step 5 is the only thing between a client bug and a public clip. Test it by uploading publicly on purpose and expecting `VIDEO_NOT_PRIVATE`.
3. **The streaming change regresses a non-media route.** PDFs and 204s are the two that break quietly. The suite from step 6 exists for this and nothing else.
4. **A video lands with no stage and the hero goes blank.** The stage rule is "newest row with a stage", so write the test with a stageless newer clip before wiring the hero.
5. **The signed URL is mutated after signing.** Any appended query parameter returns 403, and that includes a well-meaning `tr=orig-true`. Build the URL once, with the transformation inside the signature, and never touch it again.
