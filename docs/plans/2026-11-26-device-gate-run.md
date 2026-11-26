# Device gate run, 2026-11-26

The build sequence lists five device rows that must pass before `SITE_VIDEO_CAPTURE` is flipped on
for real users, and says a row without an artefact did not pass. This is what could be run without
a phone, what it measured, and what is still owed to hardware.

Runner: `apps/web/src/test/e2e/device-gate.spec.ts`, executed against the local stack
(`SITE_VIDEO_CAPTURE=true`, `MEDIA_STORAGE=local`, both storage caps set) with

    DEVICE_GATE=1 npx playwright test device-gate --project=chromium --timeout=900000

The file is skipped without `DEVICE_GATE=1`, so the default suite and CI never pay for it.

Artefacts: `docs/plans/artefacts/device-gate-results.json` (every number below),
`docs/plans/artefacts/device-gate-android13-feed.png` (the feed with the clip in it).

## What was measured

Both rows record a 20 second clip with a synthetic camera, save it through the real API, and then
play it back in the same lightbox the buyer gets. The network is shaped with CDP
`Network.emulateNetworkConditions`, in the profiles Chromium DevTools ships.

| Criterion        | Bar  | Android 13 mid, fast 3G | Android 11 low, 4x CPU, slow 3G |
| ---------------- | ---- | ----------------------- | ------------------------------- |
| Record starts    | 1.5s | 0.31s pass              | 0.52s pass                      |
| 20s clip uploads | 90s  | 44.0s pass              | 44.6s pass (120s bar)           |
| Playback starts  | 3s   | 1.87s pass              | 9.50s FAIL                      |
| Seek works       | yes  | yes                     | yes                             |
| Clip size, 20s   | n/a  | 921,009 bytes           | 1,343,569 bytes                 |
| Inline playback  | yes  | n/a                     | n/a (WhatsApp UA: pass, 0.78s)  |

Two things in that table matter more than the ticks.

The low-end emulation **misses the 3 second playback bar**, and it did so on both runs of that
row: 6.46s and then 9.50s, against 1.87s on the unthrottled profile with the same code. That is
the row the gate exists for, and it is the one that says a cheap Android 11 handset may show a
blank frame for several seconds after the buyer taps play. No assertion was relaxed to make it
pass; the harness records the number and the row fails the bar.

The clip size is not a usable signal and I nearly reported it as one. A first run produced 266KB
for the same 20 second recording on the throttled profile against 1.63MB on the other, which
looks like an encoder collapsing under 4x CPU. The rerun gave 1.34MB on the throttled profile and
0.92MB unthrottled. The synthetic camera is a static pattern, so the encoder's output swings with
scene change detection rather than with the CPU. Playback latency reproduced; bitrate did not.

## What this run cannot say

- **No radio, no camera pipeline, no thermal state.** A synthetic camera writes a fixed pattern;
  a phone encodes a real sensor feed and heats up doing it. The record-start figure here is the
  browser's, not a handset's.

- **No iPhone.** Playwright WebKit downloads and refuses to launch on this host (missing system
  libraries, and `playwright install-deps` needs root). iOS Safari also supports `MediaRecorder`
  with `avc1` only from 17.4, so rows 3 and 4 need a phone and nothing else will do.

- **The buyer's portal session was not exercised.** No OTP device here, so the WhatsApp row proves
  the player rather than the login: the clip plays inline (`playsInline` true), the clock advances,
  and no download prompt appears. The buyer's authenticated portal opening from the WhatsApp deep
  link is still unproven.

- **Backgrounding mid-upload was not attempted.** Headless Chromium has no real tab
  backgrounding; CDP lifecycle states freeze JS and would measure something a phone never does.

- **AAC in the MP4 container is not available in this build**, so the audio toggle is correctly
  absent here and its real path (a take carrying an AAC track) needs a device that can mux it.

## What a person with a phone has to do

Row 3 and 4, iPhone on current and previous iOS: open the capture screen, record 20 seconds, save,
then replay from the timeline. Check that the clip is MP4 and plays without downloading, that
permission denial offers the file picker without a reload, and that a 20 second clip uploads on
mobile data within 90 seconds.

Row 2, the low-end Android backgrounding half: start the save, switch to another app for 30
seconds, come back, and confirm the upload finished or resumed.

Row 5, buyer: open the WhatsApp thread, follow the deep link, and confirm the portal opens
signed in and the clip plays inside the webview.

Each row needs the artefact named in the table above plus the phone model and iOS or Android
version. Until then the flag stays off for real users.

## A defect this run found on the way

`pnpm run dev` could never satisfy the e2e's own prerequisite. Turbo runs tasks in strict env
mode, and `SITE_VIDEO_CAPTURE` was not in `globalEnv`, so the variable was stripped before it
reached either server: the API booted with the feature off, the capture screen rendered photo
only, and the gate spec failed three times on "no capture control" for a reason that had nothing
to do with the browser. `turbo.json` now declares the six site-video variables and `MEDIA_STORAGE`.
