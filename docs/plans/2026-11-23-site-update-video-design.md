# Site update video: UI design

Companion to `2026-11-23-site-update-video.md`. That document decides behaviour, this one decides what the engineer and the buyer actually see. Nothing here is implemented yet.

## Design direction

The screen is used by one person, one-handed, standing on a site, often in direct sun, often in a hurry. Every decision below follows from that:

- Thumb territory first. The primary actions sit in the bottom third; nothing essential lives above the fold on a 360px-wide phone.
- One decision per screen. Capture does not ask for a stage, a caption or a category. It asks: photo, video, or something you already have.
- Nothing moves under the thumb. The stop button does not resize, shift or fade mid-take.
- Honest state. If it is uploading, it says so and shows real progress. It never shows a spinner where a number is knowable.
- The photo path does not regress. An engineer who ignores video entirely must find today's screen unchanged in position, size and copy.

## Tokens

Taken from `packages/ui-tokens/src/brand.css`, so the mockup and the build agree:

| Token                  | Value                              | Use                                       |
| ---------------------- | ---------------------------------- | ----------------------------------------- |
| `--primary`            | `oklch(0.238 0.099 260.3)` navy    | primary button, active stop target, links |
| `--primary-foreground` | `oklch(0.971 0.009 84.6)`          | text on primary                           |
| `--secondary`          | `oklch(0.684 0.178 136.1)` green   | success state, saved confirmation         |
| `--muted-foreground`   | `oklch(0.525 0.041 257.44)`        | captions, durations, helper text          |
| `--destructive`        | `oklch(0.545 0.21 25)`             | stop recording, destructive confirm       |
| `--success`            | `oklch(0.53 0.16 160)`             | upload complete                           |
| Radius                 | library default (`0.625rem` scale) | tiles, sheets, buttons                    |
| Type                   | library `--font-sans`              | no new families                           |

Sunlight rule: body text on a white surface uses `--foreground` at full strength, never `--muted-foreground` below 14px. The capture bar inverts to navy so it reads against sky and concrete.

## Screen inventory

1. Capture screen (site update, unit context), idle
2. Recorder, permission and live states
3. Review (preview the clip, retake, keep)
4. Upload and save
5. Site feed: video tile
6. Portal: video tile and lightbox video state
7. Portal: WhatsApp deep-link landing

## 1. Capture screen (idle)

```
┌──────────────────────────────────┐
│  ←  Villa 12 · Site updates      │  sticky, translucent, 56px
│                                  │
│  ┌────────────────────────────┐  │
│  │  [ newest update card ]    │  │  existing feed, unchanged
│  │  poster · duration 0:24    │  │
│  └────────────────────────────┘  │
│  ┌────────────────────────────┐  │
│  │  photo · stage · caption   │  │
│  └────────────────────────────┘  │
│                                  │
│                                  │
├──────────────────────────────────┤
│  ┌──────────────┐ ┌───────────┐  │  capture bar, navy surface
│  │  📷  Photo   │ │  ⏺ Video  │  │  two equal targets, 64px tall
│  └──────────────┘ └───────────┘  │
│        Gallery ⌄                 │  overflow, text button, 44px
└──────────────────────────────────┘
```

- Photo and Video are equal weight and equal size. Photo keeps its left position so muscle memory survives, Video is new on the right where a right thumb lands.
- Gallery moves from a peer button into a text button under the bar. It is used less than photo, and burying it costs one tap, while keeping three peer buttons makes all three smaller.
- With `SITE_VIDEO_CAPTURE=0`, the Video target is absent and the bar reverts to today's single primary plus Gallery. No dead control, no "coming soon".
- Offline or no camera permission: the Video target shows a plain label, not a disabled grey blob, and tapping explains why in one line.

## 2. Recorder

Full-screen takeover, not a sheet. The camera preview is the background; controls float on a scrim so they survive any scene brightness.

```
┌──────────────────────────────────┐
│  ✕                    0:07 ⏺ 45s │  close left, timer right, mute toggle
│                                  │
│                                  │
│         [ live preview ]         │  object-fit: cover
│                                  │
│                                  │
│   ┌──────────────────────────┐   │
│   │      AUDIO  ⏻ off        │   │  44px row, only when audio supported
│   └──────────────────────────┘   │
│                                  │
│            (  STOP  )            │  72px navy target, 24px from bottom
│                                  │
└──────────────────────────────────┘
```

States, each with its own single sentence and one action:

| State            | What is on screen                                                           | Action             |
| ---------------- | --------------------------------------------------------------------------- | ------------------ |
| requesting       | preview frame, "Starting camera…"                                           | none, 1.5s ceiling |
| recording        | timer, countdown under 10s, stop                                            | stop               |
| denied-temporary | "Camera was blocked. Tap to try again."                                     | retry              |
| denied-permanent | "Camera is off for this site. Allow it in Chrome settings, or pick a clip." | open picker        |
| unsupported      | "This browser cannot record. Pick a clip instead."                          | open picker        |
| stopping         | frozen last frame, "Finishing…"                                             | none               |

Rules:

- Codecs are pinned, not inherited: `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` with audio on, `video/mp4;codecs="avc1.42E01E"` with it off. Baseline H.264 with no B-frames and AAC-LC, because Android WhatsApp clients refuse High profile with B-frames and Chrome otherwise records WebM.
- Stop is 72px, navy on the light scrim, and does not move when the countdown enters its last ten seconds. The countdown changes colour, not layout.
- Audio toggle sits above the stop target so it is reachable but never adjacent enough to hit by accident. Default off, and its state is visible as a word, not only an icon.
- The red record dot is the only saturated red on the screen; `--destructive` is reserved for the action that ends the take so nothing else competes.
- On backgrounding, recording stops and the clip is kept, with a toast "Kept your clip" and the review screen waiting when the app returns.

## 3. Review

```
┌──────────────────────────────────┐
│  ✕  Record video                 │
│  ┌────────────────────────────┐  │
│  │      [ clip, poster ]      │  │  player, preload=none, controls
│  │                0:24  🔊    │  │  duration and audio badge
│  └────────────────────────────┘  │
│                                  │
│  Stage    [ Structure ▾ ]        │  existing NoteDialog fields
│  Caption  [ …………………… ]          │
│                                  │
├──────────────────────────────────┤
│  ┌──────────┐  ┌─────────────┐   │
│  │  Retake  │  │   Use clip  │   │  secondary + primary
│  └──────────┘  └─────────────┘   │
└──────────────────────────────────┘
```

- The clip is playable here before anything uploads. An engineer who recorded a dark, unusable take finds out before spending 90 seconds of 3G.
- Retake discards without a confirm dialog: the clip is not uploaded yet, so the cost of the mistake is the take, not data.
- Stage and caption reuse the existing note fields; the video adds no new required input.

## 4. Upload and save

Two distinct phases with different words, because they fail differently:

```
uploading    ▓▓▓▓▓▓▓░░░░░░░  46%   "Uploading video…     Cancel"
saving       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%  "Saving update…"
done         ✓ green               "Update saved"           auto-dismiss 1.2s
failed       ! destructive         "Upload did not finish.  Retry"  "Cancel"
```

- Progress is real bytes, not a stage animation. If the browser cannot report progress, say "Uploading…" without a fake percentage.
- Cancel is present during upload, not after. It calls the server-side cancel route because the browser cannot delete the object itself.
- A retry reuses what already uploaded; the copy says "Retry", never "Start again".

## 5. Site feed: video tile

```
┌──────────────────────────────┐
│  ┌────────────────────────┐  │
│  │   [poster image]       │  │
│  │            ▶    0:24   │  │  play glyph, bottom-right duration pill
│  └────────────────────────┘  │
│  Structure · 23 Nov          │
│  "Plinth poured on the       │
│   east wing"                 │
└──────────────────────────────┘
```

- The row stays one `<button>`. A `<video>` is never nested inside it: invalid markup, and the player steals the tap.
- Duration is text, not an icon, so it is readable in sun and available to a screen reader.
- The tile's accessible name: "Video, 24 seconds, Structure, 23 November. Open the update." Never "play button".

## 6. Portal and lightbox

Video state inside the existing lightbox, so the photo path is untouched:

```
┌──────────────────────────────────┐
│  ← 23 November · Structure    ✕  │
│  ┌────────────────────────────┐  │
│  │        [ playing ]         │  │  native controls, playsInline
│  └────────────────────────────┘  │
│  "Plinth poured on the east      │
│   wing"                          │
│  ‹ Previous update   Next ›      │
└──────────────────────────────────┘
```

- `preload="none"`, player created on open, torn down on close, so a timeline with five clips does not download five videos.
- Undecodable clip: poster, one sentence, and a download link. Never a black rectangle.
- Keyboard: arrows change update, Escape closes, focus returns to the tile.

## 7. WhatsApp deep-link landing

The buyer taps a link in WhatsApp and is usually signed out.

```
portal link → login (email or OTP) → return to the same clip, playing
```

- The link carries the unit and the update id. After sign-in, the buyer lands on that clip, not the portal home.
- If the link is older than the retention window, the page says "This update is no longer available" rather than a 404 page.
- The deep link opens in the in-app browser, so it must work without a download prompt and without autoplay sound.

## Copy

| Context                       | Copy                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| Bar                           | Photo · Video · Gallery                                                     |
| Recorder idle                 | "Tap to record. Up to 45 seconds."                                          |
| Recording                     | "Recording · 12s left"                                                      |
| Permission denied (permanent) | "Camera is off for this site. Allow it in Chrome settings, or pick a clip." |
| Review                        | "Retake" · "Use clip"                                                       |
| Uploading                     | "Uploading video… 46%"                                                      |
| Saving                        | "Saving update…"                                                            |
| Saved                         | "Update saved"                                                              |
| Too long                      | "That clip is longer than 45 seconds. Record a shorter one."                |
| Too large                     | "That video is too large. Record up to 45 seconds."                         |
| Wrong container               | "This video format will not play here. Record it in the app."               |
| Not private                   | "That upload was not secured. Record again."                                |
| Retryable failure             | "Upload did not finish. Try again."                                         |
| Portal, expired               | "This update is no longer available."                                       |

No codes on screen. No "Oops". No exclamation marks.

## Motion

- Recorder open: 180ms slide up, preview cross-fades in over 120ms.
- Stop: no transition on the target itself; the timer freezes, the frame holds 150ms, then review slides in.
- Progress bar: linear width transition, 120ms, never a pulse.
- Tile press: 90ms scale to 0.98, matching the existing feed.
- Nothing on the capture path exceeds 200ms, because a slow stop button means a long clip.

## Accessibility acceptance

- Every control operable at 320 CSS px, one-handed, with a 72px stop target and 44px minimum elsewhere.
- Focus ring visible on navy and on white: 2px `--ring` offset 2px.
- Contrast 4.5:1 for text, 3:1 for the play glyph and duration pill against the poster. The pill carries a scrim so it holds on any frame.
- The recorder announces state changes only: "Recording", "Recording stopped", "Uploading, 46 percent", "Update saved". Not a per-second timer.
- A poster that fails to load falls back to a neutral tile with the word "Video" and the duration, never a broken image icon.

## Component mapping (`@paalstack/react-ui`, props API)

The library is shadcn parity on Base UI. Every component here exists; none is hand-rolled. Props API first, composition only where the layout demands siblings (Card). Verified against `node_modules/@paalstack/react-ui/dist/index.d.ts`.

| Screen piece          | Component                                        | Props that matter                                                                                                         |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Photo / Video targets | `Button`                                         | `variant="secondary"` on navy, `size="lg"`, `className="h-16 flex-1"`, `data-qa="capture-photo"` / `"capture-video"`      |
| Gallery overflow      | `DropdownMenu` with `entries`                    | one entry, icon `LuImages`, `data-qa="capture-gallery"`                                                                   |
| Recorder shell        | `Sheet`                                          | `side="bottom"`, full height, `contentClassName="h-[100dvh] p-0"`, `data-qa="recorder-sheet"`                             |
| Close                 | `Button` `variant="ghost"` `size="icon"`         | icon `LuX`, `aria-label="Close recorder"`, `data-qa="recorder-close"`                                                     |
| Timer                 | plain text                                       | `role="timer"` `aria-live="off"`, tabular numerals; the live region is the state, not the seconds                         |
| Audio toggle          | `Switch`                                         | `checked={audio}` `onCheckedChange`, label "Audio", `data-qa="recorder-audio"`                                            |
| Stop                  | `Button`                                         | `size="icon"` overridden to 72px, `variant="default"`, `data-qa="recorder-stop"`                                          |
| Permission states     | `AlertDialog`                                    | `cancelButtonText` "Close", `confirmButtonText` per state, `contentClassName="sm:max-w-md"`                               |
| Review player         | `Card` + `CardContent`                           | composition, `CardContent className="p-0"`, native `<video>` inside                                                       |
| Stage field           | `Select`                                         | `options` from `labelFor('constructionStage', …)`, `data-qa="video-stage"`                                                |
| Caption               | `InputGroup` with `textareaProps`                | never a bare wrapper; `textareaProps={{ maxLength: 280, rows: 3, 'data-qa': 'video-caption' }}`                           |
| Retake / Use clip     | `Button` pair                                    | `variant="outline"` + `variant="default"`, `data-qa="video-retake"` / `"video-save"`                                      |
| Save in flight        | `Button`                                         | `isLoading={saving}` `loadingText="Saving…"`, children stay "Use clip"                                                    |
| Progress              | `Progress`                                       | `value={percent}` only when bytes are knowable; otherwise indeterminate                                                   |
| Cancel upload         | `Button` `variant="ghost"`                       | `data-qa="upload-cancel"`, min 44px                                                                                       |
| Saved                 | sonner toast via `ToastProvider`                 | `toast.success('Update saved')`, 1.2s                                                                                     |
| Failure               | sonner toast                                     | `toast.error(message)` with the copy from the table, plus a `Button` action "Retry"                                       |
| Video tile            | `Card` composition                               | `CardRoot` + `CardContent className="p-0"` for the poster, then the meta block; whole card is one `<button>` via `render` |
| Duration pill         | `Badge`                                          | `variant="secondary"` on a scrim wrapper, text "0:24", `aria-hidden` because the card's name already carries it           |
| Play glyph            | icon `LuPlay`                                    | `aria-hidden`, never a nested button                                                                                      |
| Lightbox              | existing `PhotoLightbox` + `Sheet`-style overlay | video branch renders `<video controls playsInline preload="none" poster>`                                                 |
| Lightbox nav          | `Button` `variant="ghost"` `size="icon"`         | `LuChevronLeft` / `LuChevronRight`, keyboard arrows bound on the container                                                |
| Empty state           | existing `SiteEmptyHero`                         | copy changes from "Add the first photo" to "Add a photo or a clip" only when the flag is on                               |

## Library conventions this design is bound by

- **Props API first.** No `FormField`/`FormItem` composition, no `DialogRoot` unless the layout genuinely needs it. The review screen uses the props API for `Select`, `InputGroup`, `Button`.
- **Buttons never hand-roll loading.** `isLoading` + `loadingText`, never `disabled={pending}` with a ternary label.
- **Status and state use `Badge` with semantic variants.** No coloured `<span>` anywhere.
- **Single-line inputs go through `InputGroup`.** The caption field is a textarea variant of it, not a bare `<textarea>` in a `<div>`.
- **`data-qa` on every interactive element**, named in the inventory below, because the e2e specs select on them.
- **Semantic tokens only.** No raw hex in the implementation. The poster scrim uses the overlay token, not `rgba(...)`. `--primary`, `--destructive`, `--success`, `--muted-foreground` from `packages/ui-tokens/src/brand.css`.
- **Dark mode for every colour** the recorder introduces, including the scrim and the countdown warning state.
- **`focus-visible:ring-2`** on every control, `prefers-reduced-motion` respected for the sheet slide and the tile press.
- **`Dialog` and `AlertDialog` carry `contentClassName="sm:max-w-md"`**, the app-wide standard width.
- **Icons from `@paalstack/react-icons/lu`**, `aria-hidden` unless they are the only label.

## data-qa inventory

`capture-photo`, `capture-video`, `capture-gallery`, `recorder-sheet`, `recorder-close`, `recorder-audio`, `recorder-stop`, `recorder-timer`, `video-preview`, `video-stage`, `video-caption`, `video-retake`, `video-save`, `upload-progress`, `upload-cancel`, `update-tile-<id>`, `update-tile-play-<id>`, `lightbox-video`, `lightbox-next`, `lightbox-prev`.

The existing photo specs keep their markers; nothing here renames a current `data-qa`.

## What would make this design wrong

- A three-way action sheet, which makes every action smaller to keep them equal.
- Inline playback in the feed, which breaks the button semantics and costs a video element per row.
- A percentage that is not real, which teaches the engineer to distrust the number.
- An audio toggle defaulting to on, which records site noise and other people's conversations without anyone deciding to.
