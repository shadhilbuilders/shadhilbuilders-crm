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

## Known gaps: ten items, checked before the flag flips

Found by auditing the plan against the code after the gate closed. Items 1 to 4 block step 5 as written; the rest are named risks with a decision attached rather than silent assumptions.

- [ ] **1. Poster production is unspecified.** Nothing in the current body says how the frame is made, yet the CHECK makes `posterKey` mandatory for a live video. Fix: canvas grab at about one second, `toBlob('image/jpeg', 0.8)`, max 1280px wide, fall back to the first decodable frame, and a failed poster never blocks the save. **Step 5.**
- [ ] **2. The poster would land public.** Images go through `/api/media` base64, which stores them public, leaking exactly the frame the private-video decision protects. Fix: the poster uploads private through the same signed folder and the record route verifies both objects. **Step 5.**
- [ ] **3. `mediaUrl` points at the clip.** `progress-photo.mapper.ts:165` is `mediaUrlFor(row.key)`, so a video row renders its MP4 into every `<img>`. Fix: `kind === 'VIDEO' ? mediaUrlFor(posterKey) : mediaUrlFor(key)`, with a mapper test using a video row. **Step 5.**
- [ ] **4. Local dev cannot upload a real clip.** `createUploadAuth` returns `{transport:'inline', maxBytes}` with no number, against a 13.6MB clip and a historical 8MB inline ceiling. Fix: name the number, either 16MB inline for local or a short dev fixture, and say which. **Steps 2 and 7.**
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
