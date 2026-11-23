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
| 7   | UI: recorder with pinned codecs, picker, tiles, lightbox, server-wrapper flag, delete the `lastPhotoStage` alias in the commit that kills its last reader                                                                                                                                                                                 | the design's `data-qa` inventory in the DOM; Playwright records, seeks and sees 206; denied camera falls back; ffprobe on the recorded file shows Baseline or Main, no B-frames, AAC when audio is on, moov before mdat |
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

## Known gaps: ten items, checked before the flag flips

Found by auditing the plan against the code after the gate closed. Items 1 to 4 block step 5 as written; the rest are named risks with a decision attached rather than silent assumptions.

- [ ] **1. Poster production is unspecified.** Nothing in the current body says how the frame is made, yet the CHECK makes `posterKey` mandatory for a live video. Fix: canvas grab at about one second, `toBlob('image/jpeg', 0.8)`, max 1280px wide, fall back to the first decodable frame, and a failed poster never blocks the save. **Step 5.**
- [ ] **2. The poster would land public.** Images go through `/api/media` base64, which stores them public, leaking exactly the frame the private-video decision protects. Fix: the poster uploads private through the same signed folder and the record route verifies both objects. **Step 5.**
- [ ] **3. `mediaUrl` points at the clip.** `progress-photo.mapper.ts:165` is `mediaUrlFor(row.key)`, so a video row renders its MP4 into every `<img>`. Fix: `kind === 'VIDEO' ? mediaUrlFor(posterKey) : mediaUrlFor(key)`, with a mapper test using a video row. **Step 5.**
- [x] **4. Local dev cannot upload a real clip. (closed in step 2)** `createUploadAuth` returns `{transport:'inline', maxBytes}` with no number, against a 13.6MB clip and a historical 8MB inline ceiling. Fix: name the number, either 16MB inline for local or a short dev fixture, and say which. **Steps 2 and 7.**
- [ ] **5. `upload-auth` is unthrottled.** `ThrottlerModule` is imported only in `users.module.ts:12`, not globally, and each token is reusable for 600s. Fix: throttle the route, or record the acceptance in the plan's decision table. **Step 5.**
- [ ] **6. The deep link's return path has no mechanism.** No `callbackUrl`/`redirectTo` exists in `apps/web`, and an unvalidated target is an open redirect. Fix: same-origin portal paths only, allowlisted, and state where the target travels. **Step 8.**
- [ ] **7. iPhone library clips always fail.** A Photos recording is `.mov`, refused by design, so iOS supports in-app recording only. Fix: say so in the capture copy and in the device gate row, not only in the failure table. **Step 7.**
- [ ] **8. The server trusts `durationMs`.** Container and bytes are verified, duration is not, so a client can claim 20s for a 45s clip. Fix: accept it and record the decision, or read the `mvhd` duration from the first range read. **Step 5.**
- [ ] **9. The flag needs a dynamic page.** A server wrapper reading `SITE_VIDEO_CAPTURE` makes the route dynamic; if it is cached today the flag bakes at build time. Fix: confirm the route's caching mode in step 7. **Step 7.**
- [ ] **10. No flag-off test.** Nothing proves capture reverts to today's single Photo button. Fix: one e2e case with the flag off asserting the Video target is absent. **Step 7.**

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

## The five things most likely to go wrong

1. **The recorder produces a container the pipeline or Meta refuses.** Chrome may ignore the MP4 hint and record WebM, or honour MP4 but emit H.264 High with B-frames, which Android WhatsApp cannot play. `isTypeSupported` answering yes is not proof; ffprobe the actual file on the mid-range Android in step 7.
2. **The direct upload is accepted publicly.** The signature does not cover `isPrivateFile`, so the server check in step 5 is the only thing between a client bug and a public clip. Test it by uploading publicly on purpose and expecting `VIDEO_NOT_PRIVATE`.
3. **The streaming change regresses a non-media route.** PDFs and 204s are the two that break quietly. The suite from step 6 exists for this and nothing else.
4. **A video lands with no stage and the hero goes blank.** The stage rule is "newest row with a stage", so write the test with a stageless newer clip before wiring the hero.
5. **The signed URL is mutated after signing.** Any appended query parameter returns 403, and that includes a well-meaning `tr=orig-true`. Build the URL once, with the transformation inside the signature, and never touch it again.
