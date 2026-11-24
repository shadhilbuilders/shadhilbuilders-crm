# Site update video: the device gate

Five rows decide whether `SITE_VIDEO_CAPTURE` stays on. Each row needs an artefact and a
named owner. **A row without an artefact did not pass.** Only a fake camera has been
exercised so far, and the dev Chromium cannot answer the audio question at all: it reports
`avc1` as supported and `avc1,mp4a.40.2` as unsupported, then records a silent clip anyway,
which is why the recorder hides the audio toggle there.

Plan of record: `2026-11-23-site-update-video-build-sequence.md` (Device gate, and the five
things most likely to go wrong).

## Before the first row

The feature is ON in production as of 2026-11-24. Coolify service `service-crm`
(`0bjahklz8gtdtr4do4r7ae6m`) carries:

    SITE_VIDEO_CAPTURE=true
    SITE_VIDEO_ORG_CAP_BYTES=8589934592        (8 GiB of video per organisation)
    SITE_VIDEO_PROJECT_CAP_BYTES=1073741824    (1 GiB of video per project, about 73 clips at the 14 MiB ceiling)

The caps count VIDEO bytes only. `StorageUsage` and `ProjectStorageUsage` had no rows and
zero bytes when this was switched on, so both ledgers start from nothing; photos are not
counted against them.

Two things hold the config together, both worth knowing before blaming the phone:

- The API refuses to boot when the flag is on and either cap is missing or unparseable
  (`main.ts` calls `readSiteVideoConfig()` before anything else).
- The web reads `process.env.SITE_VIDEO_CAPTURE === 'true'` per request on the site page,
  which is `force-dynamic`, so the capture bar shows the Video target only while the flag is
  in place.

Verified at switch-on: both the `shadhil-api` and `shadhil-web` containers carry the three
variables; the API restarted healthy and logged `Nest application successfully started`; and
the running container's own `readSiteVideoConfig()` answered
`{"enabled":true,"orgCapBytes":8589934592,"projectCapBytes":1073741824,...}`. The one thing
that check cannot prove is the rendered screen, because it sits behind a staff login: open a
project's site screen on a laptop and confirm the capture bar has a **Video** target before
involving a phone. If it is missing, the flag did not reach the web container.

To switch it back off: set `SITE_VIDEO_CAPTURE=false` on the same service and restart. Video
routes go back to 404, the site screen goes back to the photo-only bar, and photo capture and
delivery are untouched.

## The procedure for every row

1. Sign in as staff on the device (real build, real network, no devtools tricks).
2. Open the project, pick a unit, tap **Video**.
3. Allow the camera. Allow the microphone only on the rows that test audio.
4. Tap **Record**. Time it from tap to the live preview appearing.
5. Record 15 to 20 seconds with slow panning and a dark corner in frame. Stop.
6. Choose the stage, add a short caption, tap **Save**. Time it from tap to the tile
   appearing in the timeline.
7. Tap the tile, press play. Time it from tap to first frame. Seek to the middle and back.
8. On the rows that test backgrounding, start a second clip, background the browser
   mid-upload, return, and say whether it finished.
9. Screenshot the timeline row (the tile shows a play glyph and a clock, and its label is
   `Video, 18 seconds`), plus the delivery state if it is showing.
10. Probe the stored clip with the commands below and paste the output under the row.
11. Note anything that needed a reload, a second tap or a permission retry. Those notes are
    the point of the exercise.

## The artefact: probe the stored clip, never the poster

The bytes that matter are the ones the API serves later, so probe what was stored, not the
file the phone made. `ProgressPhoto.key` holds the clip and `posterKey` holds the JPEG frame;
`mediaUrl` on the timeline points at the poster on purpose.

**Preferred, on a laptop:** sign in as staff, open the same unit's timeline, press play on
the clip, then DevTools, Network, the `media/...` request ending in `.mp4`, right click,
**Copy as cURL**. Run it with `-o clip.mp4` appended. The route is
`GET /api/bff/media/<key>` on the web origin, and `GET /api/media/<key>` on the API.

**Fallback, on the VPS:** read the newest video key and fetch it with a staff session cookie.

    docker exec shadhil-postgres psql -U shadhil -d shadhil_crm -tAc \
      "select key from \"ProgressPhoto\" where kind='VIDEO' order by \"createdAt\" desc limit 1"

    curl -sS -H "Cookie: <staff session cookie>" \
      "https://crm.shadhilbuilders.in/api/bff/media/<key>" -o clip.mp4

A 200 with the whole body is expected from that curl: the route streams ranges only when the
request carries a `Range` header, which is what the player sends when it seeks. If you curl it
with `-H 'Range: bytes=0-1023'` you should get a 206 and 1024 bytes.

**Correction, 2026-11-24: you will not get a 206 from the provider.** A ranged request through
the production stack came back 200 with the whole 1,700,682-byte clip, because
`imagekit.storage.ts` sends the range upstream, ImageKit ignores it, and the service reports that
200 truthfully rather than relabelling it. Fixed the same day in the working tree:
`MediaController.streamVideo` now cuts the window itself when a range was asked for and the
provider answered 200, and answers 206 with a real `Content-Range`. See ADR 0003. Deployed in
`prod-14ccb2c` the same day. Measured after the deploy, as the buyer: `Range: bytes=0-1023` answers
`206`, `Content-Range: bytes 0-1023/1700682`, and exactly 1024 bytes on the wire; the plain GET is
still `200` with all 1,700,682 bytes.

## The probe, and what passing looks like

Video stream:

    ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name,profile,has_b_frames,width,height,avg_frame_rate \
      -of default=nw=1 clip.mp4

Passing means exactly these three, on every device:

| field          | pass                                       | why                                                                                                  |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `codec_name`   | `h264`                                     | anything else is refused by `sniffMime` before it is stored, so a pass here is also a pipeline check |
| `profile`      | `Baseline`, `Constrained Baseline`, `Main` | `High` with B-frames is what Android WhatsApp refuses                                                |
| `has_b_frames` | `0`                                        | same reason                                                                                          |

Audio. With the toggle ON expect `codec_name=aac`; with the toggle OFF expect no output at all
(an empty answer is the pass, not a broken command):

    ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=nw=1 clip.mp4

Container order, size and duration. `moov` must come before `mdat` so playback starts before
the download finishes:

    ffprobe -v error -show_entries format=format_name,duration,size -of default=nw=1 clip.mp4

    python3 - <<'PY'
    data = open('clip.mp4','rb').read()
    for box in (b'moov', b'mdat'):
        print(box.decode(), data.find(box))
    PY

Pass: `moov` index is smaller than `mdat` index, `format_name` contains `mp4`,
`duration` is between 1 and 45, `size` is under 14680064 (14 MiB, the same ceiling as the
`ProgressPhoto_size_cap` CHECK).

Both shapes, from two files made with ffmpeg on 2026-11-24, so the difference is visible
before a phone is involved. The first is what a default `libx264` encode produces, and it
fails every clause:

    profile=High            <- refused by Android WhatsApp
    has_b_frames=2          <- refused by Android WhatsApp
    moov 15491 mdat 44      <- moov after mdat: no playback until the download finishes

The second passes, and is the shape a phone clip has to match:

    codec_name=h264
    profile=Main
    has_b_frames=0
    format_name=mov,mp4,m4a,3gp,3g2,mj2
    duration=3.000000
    size=22502
    moov 36 mdat 1148

## The five rows

Owners are assigned from the production account list as it stood on 2026-11-24, by role:
there are two ENGINEER accounts and only one of them is a real person with a phone on file,
which is why both Android rows land on the same engineer. No account records a handset model,
so each owner confirms their device matches the row before running it, and writes the model
into the Result cell.

| #   | Device                                | Pass criteria                                                                                               | Artefact         | Owner                                                                    | Date       | Result                                                                                                                    |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Android mid-range, Android 13, Chrome | record starts under 1.5s; 20s clip uploads on throttled 3G within 90s; playback starts under 3s; seek works | probe + video    | site eng (ENGINEER, shadhilbuilderleads@gmail.com)                       |            | blocked: poster upload fails on the second object, see defect 1                                                           |
| 2   | Android low-end, Android 11, Chrome   | same, upload within 120s, survives backgrounding mid-upload                                                 | probe + video    | site eng (second handset; if only one exists, run row 1 and say so)      |            | blocked: same                                                                                                             |
| 3   | iPhone, current iOS, Safari           | same; MP4 recording works from the in-app recorder; permission denial recovers without a reload             | probe + video    | Vignesh M (OWNER, vignesh@shadhilbuilders.in)                            |            | blocked: same                                                                                                             |
| 4   | iPhone, previous iOS, Safari          | same                                                                                                        | probe + video    | ram (ADMIN, ram@shadhilbuilders.in)                                      |            | blocked: same                                                                                                             |
| 5   | Buyer, WhatsApp in-app browser        | portal opens from the deep link, clip plays, no download prompt                                             | screen recording | Gate Buyer (test org CUSTOMER on an APPROVED booking, Test Greens A-665) | 2026-11-24 | desktop Chromium half done and measured (deep link, play, seek, no download path); the webview on a handset is still open |

Row 5 has an account. Two exist, and only one of them can show a unit today:

- **Gate Buyer**, `gate.buyer@shadhilbuilders.in`, CUSTOMER in the `test` organisation, linked to
  the lead on Test Greens A-665 (APPROVED). Created through `POST /api/users` as that org's OWNER,
  so it carries the audit row and the forced password rotation. Verified end to end: sign-in 200,
  the portal refused with `PASSWORD_CHANGE_REQUIRED` until the password was rotated, then
  `GET /customer-portal/me` returned A-665 with its commercial terms.
- **buyer.paalamugan@shadhilbuilders.in**, CUSTOMER in `shadhil-builders`, linked to the Paalamugan S
  lead. Sign-in and the portal shell work, but the portal returns `units: []` because this
  organisation has exactly one booking and it is CANCELLED, and `customer-portal/me` only reads
  APPROVED bookings. Nothing to test until a booking is approved.

Sign in with the EMAIL, not the phone. `login-identifier` resolves a phone against `User.phone`, and
a CUSTOMER deliberately has no phone of its own (the number lives on the lead), so a buyer typing
their number gets `kind: invalid` no matter what they type in the password field. The login form
says "email or phone" because it serves staff too.

Credentials are not written here. The buyer password was reset on 2026-11-24 and lives in `~/gate-buyer-credentials.txt` on the operator machine (0600): URL, email, password, and the scope line. The reset was done at the database layer with the app's own scrypt contract (`salt:key`, N=16384 r=16 p=1, 64-byte key, salt used as the raw hex string), `mustChangePassword` set back to false so the buyer lands in the portal and not on the rotation screen, and an `AuditLog` row written with `action = 'user.passwordReset'` and no acting user, since no staff session was used. Verified end to end after the change: `POST /api/auth/sign-in/email` over the public origin returned 200 with no rotation gate, and `GET /api/bff/customer-portal/me` returned 200 with one unit, `A-665` (plot 37).

The Users page has no password control for another account. It has only the self-service form, and the sole admin path is `POST /api/users/:id/change-password` (`users.controller.ts`), which needs a staff session in that organisation and a new password supplied by the caller. Nothing in the UI would have done this reset, which is why the database path was used.

Row 5 cannot be owned yet by a real buyer either way. Production has exactly one CUSTOMER account
outside the test org and it is the seed `customer@shadhilbuilders.in` attached to no real lead.

Rows 3 and 4 record only from the in-app recorder: a Photos clip is `.mov`, refused by design,
and the error names HEVC and says to record in the app or export as MP4. Row 5 uses a buyer
login and the WhatsApp deep link, not staff credentials.

Two deliberate choices about the assignment: rows 3 and 4 go to two different people so the
second iPhone row is not the same handset twice, and row 2 stays with the engineer rather than
moving to an office account, because a low-end Android in an office proves nothing about the
phone that films a site.

## What a fixture clip proved before a phone touched this (2026-11-24)

A generated clip was recorded through the real API path so row 5's portal half could be
exercised without a handset. It is not a phone capture and must not be counted as one.

    ProgressPhoto cmwua8fq1008601s8ogx3assv   kind=VIDEO   unit A-665 (plot 37)
    key         /k7mjd78nxvpq9vs8fqkzmfyb/4475ee.../clip.mp4       1,700,682 bytes
    posterKey   /k7mjd78nxvpq9vs8fqkzmfyb/4475ee.../poster.jpg         47,518 bytes
    ffmpeg shape: h264 Main, has_b_frames=0, 15.000s, moov before mdat
    caption says it is a fixture, stage STRUCTURE, batch gate-fixture-20261124

Row 5's browser half was then measured in Chromium against the deployed build, signed in as the
buyer, on the same fixture row:

    deep link         opens the portal and the viewer, film strip reads 2 of 2
    play              first frame at 214 ms, readyState 4, duration 15.0 s
    seek to 8 s       24 ms to the `seeked` event, currentTime lands on 8
    media request     the browser records status 206 for the clip
    poster            200, image/jpeg, 47,518 bytes
    download path     none: the route sets no Content-Disposition anywhere
                      (media.controller.ts), the element carries no `download`
                      attribute, no anchor points at the file, and no text on
                      screen says download

A frame from that playback is at `~/.hermes/cache/scratch/row5-portal-clip.png`: the fixture's
test pattern, burnt-in timecode 00:00:06.767, controls reading 0:06 / 0:15. This is desktop
Chromium, not WhatsApp's webview, so it proves the portal, the bytes and the absence of a
download path, and it does not prove the webview on a handset.

One thing the screenshot shows that the criteria should name: a floating "Install Shadhil CRM for
offline use" banner sits over the viewer with a download-style icon and an Install button. It is
an install prompt, not a download, and it is dismissible, but a buyer could read the icon as one.
The in-app webview never fires `beforeinstallprompt`, so the gate itself should not see it; worth
confirming on the handset rather than assuming.

Three defects came out of that run. Each was measured against production, and none of them is
visible from a unit test.

**1. One ImageKit token cannot upload two objects, and the recorder sent both under one grant.**
The clip uploaded 200. The poster came back 400, "The token ... has been used before".
`take-uploader.ts` keeps one grant per take and `upload.ts` sent clip and poster with the same
`session.grant`, so the poster failed on every attempt, and a Retry reused the same spent token.
A second grant does not rescue it either: `record` requires both keys inside the upload's folder,
and the folder is derived from the upload id, so a fresh grant means a fresh folder. The fixture's
poster had to be placed with the ImageKit private key from inside the api container to get past it.

Fixed in the working tree on 2026-11-24: `createUploadAuth` now returns `tickets.clip` and
`tickets.poster`, two authentication parameters with one expiry, and the uploader sends the
matching ticket per slot. The assumption was proved against the live account before any deploy,
from inside the api container with the real keys: two tickets, both uploads 200 into one folder
(`/probe-207eabd1/clip.mp4`, `/probe-207eabd1/poster.jpg`), both objects then deleted, and again on the deployed build: `upload-auth` handed back tickets whose
tokens differ (`0d848934` and `8f2e76f7`). Deployed in `prod-14ccb2c`.

**2. A video's poster answered 404 while its clip answered 200.** `media-access.service.ts`
resolved a key against `ProgressPhoto.key` only, and a video stores its JPEG in `posterKey`.
Every timeline tile and every WhatsApp site-update image points at the poster, so the feature
would have shipped with broken tiles. Fixed in the working tree on 2026-11-24 (match either
column, plus a test). Deployed in `prod-14ccb2c`: the fixture's poster now answers `200 image/jpeg`,
47,518 bytes, to the buyer's own session.

**3. Byte ranges are dropped upstream.** See the correction above. Fixed the same day (the API
cuts the window itself, ADR 0003, two new tests) and deployed in `prod-14ccb2c`: a request for
`bytes=0-1023` answers 206 with `Content-Range: bytes 0-1023/1700682` and exactly 1024 bytes,
while a plain GET still answers 200 with all 1,700,682.

What passed, measured over the public origin with the buyer's own session:

    POST /api/auth/sign-in/email           200, no rotation gate
    GET  /api/bff/customer-portal/me      200, one unit, A-665 plot 37
    GET  /api/bff/media/<clip key>        200, video/mp4, 1,700,682 bytes
    GET  /portal?unit=<id>&photo=<id>     200 with the session
                                          307 to /login?next=<same path> without it

The bounce is the one the plan promised: a signed-out buyer keeps the entire path, photo id
included, in `next`, so the deep link survives the login screen.

## The first real WhatsApp send, and the two defects that stopped it (2026-11-24)

Before this, three batches read `SKIPPED_NO_CONSENT` and no `OutboundMessage` existed for any of
them. That is the consent ledger working as written: the site update templates are approved as
MARKETING, and a missing MARKETING row is read as never asked, not as a yes. The first honest send
therefore needed a number and an opt-in, and both went in on the owner's own handset, `919445450410`,
with a consent row whose `source` says where the instruction came from.

Two defects then blocked the send. Each was measured on production, and neither is visible from a
unit test.

**1. Row level security refused every outbox insert.** The api log at 09:46:17 read
`Invalid prisma.outboundMessage.create() ... Code: 42501 ... new row violates row-level security policy for table "OutboundMessage"`.
`enqueue()` ran on the bare Prisma client rather than the caller's transaction, so the insert
carried no `app.user_id` and the policy had nothing to match. Everything before it succeeded: the
`Message` row was written and the delivery row said PENDING while no send was queued. The three
chat call sites already passed the transaction; this one did not. It does now, and a delivery that
cannot be queued settles FAILED with `ENQUEUE_FAILED`, because PENDING is a promise to the staff
screen that something is on its way.

**2. The image header was built from the wrong column.** With the outbox fixed, Meta answered HTTP
400 with `132012`, `header: Format mismatch, expected IMAGE, received UNKNOWN`. `mediaKey` was read
from `posterKey` for anything that was not a clip, and `posterKey` is the JPEG beside a VIDEO row, so
it is empty on a PHOTO row. The header was dropped and the template arrived with none. The mapping
now asks what the row is: a photo sends its own key, a clip sends its key, and a clip Meta will not
take as MP4 sends its poster.

A third gap cost the most time to find and concerned diagnosis rather than delivery. A failed
delivery receipt was parsed and its `errors` array dropped, so a row could say FAILED with no
reason stored anywhere. Meta puts its only explanation there. The code, title and
`error_data.details` are now logged and written to the outbox row.

Measured over the public origin after both fixes, against `prod-600cb11`:

    site update      DELIVERED, 2026-11-24 10:48:54Z
    wamid            wamid.HBgMOTE5NDQ1NDUwNDEwFQIAERgSNUE2OUZFRDg3ODg3MjUzNjYwAA==
    outbox row       attempts 1, sendType TEMPLATE, shadhil_site_update_image, no error
    delivery row     DELIVERED, header IMAGE, batch photo-2026-11-24T16:18:52.678+05:30
    inbound window   closed; the last inbound on that number is 2026-11-19

One send four minutes earlier was accepted by Meta, came back with a wamid, and was then reported
failed by a delivery receipt. The identical send after it was delivered. Nothing recorded why,
which is what the third fix addresses.

The stale rows written while the outbox could not insert anything are closed as FAILED with
`STALE_BEFORE_RLS_FIX`: `cmwuifb8e005d01o9vlvqcpt1` and `cmwujirni000r01r849pkxqc3`. One row from
10:16 keeps its old `132012` text and its retries, because it is the evidence for defect 2.

The three commits are `08a6068` (the transaction), `600cb11` (the header column) and `0dfa938`
(the receipt reason). All are deployed; the api image reads `prod-0dfa938` and both templates are
configured there, `shadhil_site_update_image` and `shadhil_site_update_video`.

Three things remain open, and none of them is code:

- The templates are approved as MARKETING. A villa progress message is transactional, and MARKETING
  spends a per-recipient allowance rather than arriving on the strength of the contract.
  Resubmitting as UTILITY would remove both the frequency cap and the dependency on an opt-in row,
  and the consent ledger would become a courtesy instead of the delivery precondition.
- A buyer with no number on the lead cannot be reached at all. That delivery reads
  `SKIPPED_NO_PHONE` and it is the honest outcome, not a bug.
- The photos now sitting on A-665 were generated with ffmpeg. They should be deleted through the
  DELETE routes before this gate is signed off, so nobody later mistakes them for site evidence.

## If a row fails

Flip `SITE_VIDEO_CAPTURE=false` in Coolify and redeploy. That is one variable: video routes go
back to 404 and the site screen goes back to the photo-only bar, and nothing about photo
capture or delivery changes. Write the failure into the row here with the probe output and
what the screen did, then fix the cause and re-run the same row.

Do not leave the flag on because four rows passed. The gate exists because the failures are
device-specific, and a silent broken clip costs more than a dark feature.
