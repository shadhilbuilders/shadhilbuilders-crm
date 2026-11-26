# Phone sheet, site update video

Four checks are left, and none of them can be done without a handset. This is the sheet: what to
do, on which device, and what to write down so the row counts as passed. One page, run in order,
stop at the first failure and note it.

## Before you start

The camera needs a secure context. A phone cannot open `http://localhost:3000`, and a plain
`http://<lan-ip>:3000` will not do either: browsers only hand over the camera on `https://` or on
localhost. So the stack has to be reachable over HTTPS from the phone.

**Route A, Tailscale over HTTPS.** The tailnet is already on this box (100.81.0.50) and the iPhone
is enrolled as `iphone182`, last seen 19 days ago. Do this once, and type your password when asked:

    sudo tailscale set --operator=$USER
    tailscale serve --bg --https=443 http://127.0.0.1:3000
    tailscale serve status

Then on the phone, with the Tailscale toggle on, open the address serve prints, which is
`https://laptop-3pl765iv-2.taild43b86.ts.net`. It carries a real certificate, it works on mobile
data, and it needs no port forwarding. `https://laptop-3pl765iv-2.taild43b86.ts.net` is now in
`trustedOrigins`, without which better-auth answers every sign-in with 403 INVALID_ORIGIN, and the
host is in `allowedDevOrigins` in `apps/web/next.config.ts`, without which the page arrives
unhydrated: the form renders, nothing is clickable, and no request is ever made. Both were needed
and both are in. If the tailnet name ever changes, those two lines change with it.

**Route B, a quick tunnel.** `cloudflared tunnel --url http://localhost:3000 --no-autoupdate`,
then the `https://something.trycloudflare.com` address it prints. Test with
`curl -I https://<tunnel>/login` first; from this machine on 2026-11-26 it returned 404 at the edge
for three fresh tunnels without a single request reaching Next, so treat this as the fallback.

Do not go the Windows-LAN route. It needs an elevated prompt, it breaks when the Wi-Fi network
changes, and guest networks isolate clients so the phone cannot see the host at all.

Both servers must run with the feature on:

    SITE_VIDEO_CAPTURE=true MEDIA_STORAGE=local \
    SITE_VIDEO_ORG_CAP_BYTES=5368709120 SITE_VIDEO_PROJECT_CAP_BYTES=536870912 pnpm run dev

Sign in as `engineer@shadhilbuilders.in` with `engineer_placeholder_pw`. Open a villa, then the
video target in the capture sheet.

## 1. Low-end Android, the backgrounding half (row 2)

Row 2 already passes record start and upload in an emulated browser. What it cannot show is what
Android does to an upload when the app leaves the screen.

    Start a 20 second clip. Press Save. As soon as the save starts, go to another app for 30
    seconds. Come back.

Pass: the clip is in the timeline afterwards, once, and the row shows the delivery status rather
than an error. Note how long the whole thing took. If it fails, note the exact wording on screen
and whether the clip appears twice (a resumed upload that started over would do that).

## 2. iPhone, current iOS (row 3) and previous iOS (row 4)

Same sequence, on Safari. Four things specifically:

- The record target opens and recording starts in under 1.5 seconds.
- A 20 second clip saves, uploads on mobile data in under 90 seconds, and plays back in the
  timeline without a download prompt. If the iPhone offers to download instead of playing, that
  is a fail and it is worth knowing today.
- Seek works: scrub the timeline to the middle and the frame moves.
- Deny the camera once (`Settings > Safari > Camera > Deny`, or deny at the prompt), press Record,
  and confirm the sheet offers the file picker without a reload.

One thing to watch on the iPhone: the app used to send `Permissions-Policy: camera=()`, which
denies the camera to the page itself and which Safari enforces. Chromium does not enforce it, so
recording worked in every test here while the header said otherwise. It is now
`camera=(self), microphone=(self)`. If Safari still refuses the camera, that is the first place to
look, and the second is the site settings for the origin.

## 3. Buyer through WhatsApp (row 5)

Needs a lead with a phone that has WhatsApp and a portal session.

    Open the WhatsApp thread for a villa, follow the portal link, then open the clip.

Pass: the portal opens signed in, the clip plays inside the WhatsApp webview, and there is no
download prompt. The player is already proven to be `playsinline` under a WhatsApp user agent;
what is untested is the buyer's own login and the webview itself.

## What to write down

For every row: device model, Android or iOS version, and the numbers you saw (record start, upload
time, playback start). A row without that did not pass. Send them to me and I will put them in
`docs/plans/artefacts/device-gate-results.json` and update the table in
`docs/plans/2026-11-23-site-update-video-build-sequence.md`.

Until then the flag stays off for real users. The emulated run already shows the low-end row
missing the 3 second playback bar twice, so the likely outcome is that low-end Androids need more
work before the flip, not that the sheet comes back clean.
