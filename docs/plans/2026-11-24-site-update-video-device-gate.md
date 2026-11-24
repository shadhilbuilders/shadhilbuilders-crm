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

| #   | Device                                | Pass criteria                                                                                               | Artefact         | Owner                                                               | Date | Result |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------- | ---- | ------ |
| 1   | Android mid-range, Android 13, Chrome | record starts under 1.5s; 20s clip uploads on throttled 3G within 90s; playback starts under 3s; seek works | probe + video    | site eng (ENGINEER, shadhilbuilderleads@gmail.com)                  |      |        |
| 2   | Android low-end, Android 11, Chrome   | same, upload within 120s, survives backgrounding mid-upload                                                 | probe + video    | site eng (second handset; if only one exists, run row 1 and say so) |      |        |
| 3   | iPhone, current iOS, Safari           | same; MP4 recording works from the in-app recorder; permission denial recovers without a reload             | probe + video    | Vignesh M (OWNER, vignesh@shadhilbuilders.in)                       |      |        |
| 4   | iPhone, previous iOS, Safari          | same                                                                                                        | probe + video    | ram (ADMIN, ram@shadhilbuilders.in)                                 |      |        |
| 5   | Buyer, WhatsApp in-app browser        | portal opens from the deep link, clip plays, no download prompt                                             | screen recording | BLOCKED, see below                                                  |      |        |

Row 5 cannot be owned yet. Production has exactly one CUSTOMER account and it is the seed
`customer@shadhilbuilders.in` attached to no real lead, so there is no buyer to send a WhatsApp
link to. Creating a buyer account for a real lead comes first, and then the row is owned by
whoever handles that buyer's updates.

Rows 3 and 4 record only from the in-app recorder: a Photos clip is `.mov`, refused by design,
and the error names HEVC and says to record in the app or export as MP4. Row 5 uses a buyer
login and the WhatsApp deep link, not staff credentials.

Two deliberate choices about the assignment: rows 3 and 4 go to two different people so the
second iPhone row is not the same handset twice, and row 2 stays with the engineer rather than
moving to an office account, because a low-end Android in an office proves nothing about the
phone that films a site.

## If a row fails

Flip `SITE_VIDEO_CAPTURE=false` in Coolify and redeploy. That is one variable: video routes go
back to 404 and the site screen goes back to the photo-only bar, and nothing about photo
capture or delivery changes. Write the failure into the row here with the probe output and
what the screen did, then fix the cause and re-run the same row.

Do not leave the flag on because four rows passed. The gate exists because the failures are
device-specific, and a silent broken clip costs more than a dark feature.
