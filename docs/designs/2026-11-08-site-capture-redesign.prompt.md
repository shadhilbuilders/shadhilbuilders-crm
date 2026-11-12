# Site engineer capture surface: redesign prompt for Cursor Agent SDK

> NOT PART OF THE PROMPT. Read this yourself, then hand everything between
> `--- BEGIN PROMPT ---` and `--- END PROMPT ---` to the agent.

Why these calls, in one line each:

- **Route, not modal.** A sheet is a sales surface. A site engineer works on a
  phone, gets interrupted, and the browser unloads backgrounded tabs. A modal
  loses its state when that happens; a URL does not, and it can be shared over
  WhatsApp ("shoot B-101 today"). It also deletes the single-tab chrome for free.
- **One CTA, not a button next to a dashed box.** Both read as clickable today,
  and neither one is a photo.
- **The note is written at capture time, not after.** Right now the caption is
  server-generated ("Phase B November 2026") and the engineer has to upload,
  then find a pencil icon, then edit. That is two extra taps to say the one
  thing that matters, and it needs a small backend change to fix properly.
- **Photo big, comment as the headline, metadata small.** Today it is a 64px
  thumbnail with a truncated caption: exactly backwards for a photo job.
- **Drop the phase chip per row.** Every photo of a unit carries the same phase
  (the unit's own), so the chip repeats a constant on every row and
  discriminates nothing. It stays in the note sheet, where it is real context.
- **A separate home page, because Inventory is somebody else's screen.** The
  engineer's real question is "which villa have I not photographed yet", and a
  rupee grid answers none of it.
- **A stage, because "status of the house" is not a sentence.** The engineer
  records a construction stage with each photo, the unit's current stage is the
  newest one, and the buyer gets a progress stepper instead of a wall of dates.
- **The upload surface is the library, not a bare input.** `FileUpload` carries
  the validation, rejection messages, drag and drop, multi-select and per-file
  state. The one exception is the camera button, because the component does not
  expose `capture` and losing it costs a tap on every single photo.
- **Photos are converted before they leave the phone.** The server already
  rejects HEIC bytes, so an iPhone in HEIC mode hits a dead end on site today.
  Convert to a 1600px WebP at capture time: HEIC works, and a 4MB shot becomes
  a few hundred kilobytes over site signal.
- **The note has to reach a human.** Today the caption is invisible in the
  buyer's feed (it only exists inside the photo lightbox) and no staff member is
  notified of anything. So the redesign also makes the buyer read it and tells
  the project's photo lead and team managers that it landed.
- **Colour must encode the answer to that question.** Four documentation states
  (no photos, today, this week, stale) give the page more colour than it has
  today and make it scannable in sunlight. Decorative colour would just make it
  a toy, so every hue is tied to a timestamp and every state also says its name
  in words.

---

--- BEGIN PROMPT ---

You are implementing a UI redesign in the shadhil-crm monorepo. Work
autonomously end to end: read the code, write the code, run the tests, and only
stop when the definition of done at the bottom is satisfied. Do not come back
with a plan, a stub, or a question you could answer by reading the repo.

## Context you must load before writing a line

1. `AGENTS.md` (repo root) and `apps/web/AGENTS.md`.
2. `node_modules/@paalstack/react-ui/skills/paalstack-react-ui/SKILL.md` in
   `apps/web`. This is the authority on the component library you will use.
   Every component below comes from `@paalstack/react-ui`; icons come from
   `@paalstack/react-icons/lu`. Do not invent props.
3. These files, in full:
   - `apps/web/src/components/inventory/UnitProgressTab.tsx`
   - `apps/web/src/components/inventory/UnitDetailSheet.tsx`
   - `apps/web/src/components/inventory/ProgressPhotoActions.tsx`
   - `apps/web/src/components/inventory/UnitProgressTab.test.tsx`
   - `apps/web/src/components/portal/portal-timeline.tsx` and
     `apps/web/src/components/portal/portal-format.ts`
   - `apps/web/src/hooks/queries/customer-progress.ts`
   - `apps/web/src/hooks/queries/inventory.ts` (see `useUnit`, line 169)
   - `apps/web/src/lib/session.ts`, `apps/web/src/lib/nav.ts`,
     `apps/web/src/lib/labels.ts`
   - `apps/web/src/app/[orgSlug]/projects/[projectSlug]/inventory/page.tsx`
   - `apps/backend/src/customer-progress/customer-progress.service.ts`
     (see `buildCaption` line 83 and `UploadPhotoSchema`)
   - `packages/ui-tokens/src/brand.css`

Stack facts: Next.js 16 App Router, React, Tailwind v4, TanStack Query,
Turborepo + pnpm. Brand: navy `--primary` (#001a4c), green `--secondary`
(#62b132). Semantic tokens only. `@paalstack/react-ui` exposes a Props API
(preferred) and a composition API.

## What is broken today, with evidence

The person using this screen is a site engineer standing in a half-built unit
with dusty hands, a phone in one hand, and one job: photograph the unit and say
what changed. The current surface fights all three.

1. **Single-tab chrome.** For ENGINEER/TELECALLER, `UnitDetailSheet` renders a
   `Tabs` with exactly one item ("Progress"). A tab underline with nothing to
   switch to reads as a broken page.
2. **Two competing empty states.** The screenshot shows an "Add first photo"
   button directly above a large dashed "No photos yet" box. Both look
   clickable. Neither is a photo. The dashed box is dead space.
3. **The comment cannot be written at capture time.** `UploadPhotoInput`
   (`hooks/queries/customer-progress.ts`) has no `caption` field, and the
   server fills `buildCaption(phaseName, takenAt)` → "Phase B November 2026".
   To add a real note the engineer must upload, then find a pencil icon, then
   edit. Two extra taps for the only content that matters, and until they do it
   every photo reads as machine text.
4. **Backwards hierarchy in the timeline.** A 64px thumbnail
   (`size-16`) with a `truncate` caption. The photo is the content and the
   caption is the sentence; both are shrunk to fit a row meant for text.
5. **Prices in the engineer's field of view.** They reach this screen through
   the Inventory table, which is a sales surface full of rupees. None of it is
   any use on site.
6. **Tiny always-on row actions.** Edit and delete are two ghost icon buttons
   on every row, at `size-1` icon scale, inside a crowded row. On a phone those
   are hard to hit and easy to hit wrongly.
7. **No in-flight feedback.** An upload on site 3G gives a disabled button and
   nothing else. The engineer taps again.

## The design: three taps

Pick the unit → shoot the photo → type one line. Everything else is metadata.
Build in this order, one slice at a time, keeping the tree green after each.

### Slice 0: the data the home page needs (backend first)

`UnitRow` carries nothing about photos, so every colour, count and sort on the
engineer's home page would be invented. Add two real fields once, in the shared
unit row.

`apps/backend/src/inventory/unit-row.ts`:

- `UNIT_ROW_SELECT`: add
  `progressPhotos: { select: { takenAt: true }, orderBy: { takenAt: 'desc' }, take: 1 }`
  and `_count: { select: { progressPhotos: true } }`.
- `toUnitRow`: `lastPhotoAt: row.progressPhotos[0]?.takenAt.toISOString() ?? null`
  and `photoCount: row._count.progressPhotos`.

`packages/api-types/src/inventory.ts`: add both to the unit row schema,
`lastPhotoAt` nullable and `photoCount` a non-negative int. Match the datetime
style already used in that file, do not invent one.

`apps/web/src/hooks/queries/inventory.ts`: mirror both on the `UnitRow` type.

`apps/backend/src/inventory/unit-row.test.ts` pins the mapper against the
schema, so it goes red on purpose. Fix it, and fix any other fixture that
builds a `UnitRow`.

No migration and no RLS change: `Unit.progressPhotos` and
`ProgressPhoto.takenAt` already exist. `list()`, `findOne()` and `plots()` all
share this mapper, so all three gain the fields and the sales detail sheet can
show "Last photo 3 days ago" for free.

### Slice 0b: the site home page, which replaces Inventory for them

Today the engineer lands on a sales grid: rupees, booking status, pagination.
Build their own first screen.

Route: `apps/web/src/app/[orgSlug]/projects/[projectSlug]/site/page.tsx`.

Nav: add
`{ href: '/site', label: 'Site updates', icon: LuCamera, group: 'work' }` to
`NAV_ITEMS` in `apps/web/src/lib/nav.ts`, visible only to `isSiteRole`, and make
`isNavItemVisible` hide `/inventory` for those roles. Both routes stay in
`PROJECT_SCOPED_PATHS`. Do not show two links to the same job.

Data: `useInventoryUnits({ projectId, limit: 200 })`. 200 is the server cap
(`UnitFilterDto`), and a villa project fits inside it, so the counts can be
computed client-side. If `rows.length === 200`, hide the counts and render
`Showing the first 200 units` instead of a number that lies.

Top to bottom:

1. Header: `Site updates`, subtitle `{projectName}`.
2. Three stat tiles in a row. Each is a tinted surface with a `tabular-nums`
   number and a short label. Real numbers only.
3. Filter row: `ToggleGroup`, single select, `All` / `Needs a photo` / `Updated`
   / `No photos`. Default to `Needs a photo` when that count is above zero,
   otherwise `All`.
4. Search: `InputGroup` with `addonStart={<LuSearch aria-hidden="true" />}` and
   `inputProps={{ 'data-qa': 'site-unit-search', placeholder: 'Find a villa number' }}`.
5. The list, grouped by phase. Inside a group, sort by staleness with the most
   neglected first, then by unit number. Each phase is a `CardRoot` with a
   coloured 4px left rail and a heading row (`Phase B` plus `24 units` muted).
   Inside it, an `ItemGroup` of `Item` rows.
6. One row:

```
<Item asChild variant="default" className="px-3">
  <Link href={`/site/${unit.id}`} data-qa="site-unit-row">
    <ItemMedia variant="icon" className={stateTint}>   // 40px rounded square
      {state === 'none' ? <LuCamera /> : <LuCheck />}
    </ItemMedia>
    <ItemContent>
      <ItemTitle className="tabular-nums">{unit.unitNumber}</ItemTitle>
      <ItemDescription>
        {unit.bhk} BHK · {unit.facing ?? 'Facing not set'} · {stalenessLabel}
      </ItemDescription>
    </ItemContent>
    <ItemActions>
      <Badge variant={stateBadge}>{stateLabel}</Badge>
      <LuChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
    </ItemActions>
  </Link>
</Item>
```

7. Empty states: no units at all gets the library `Empty` component with
   `No villas on the board yet` and `Units appear here once they are added to a
phase of this project.` A filter that matches nothing gets one quiet line,
   not the same copy.

   Careful with the wording: there is no per-engineer unit assignment in this
   product. `unit_select_team_member` grants a project-wide member scope, so an
   engineer sees every unit of every project their team is on. Never write
   "assigned to you" in this UI; it describes a relationship the data does not
   have.

8. Loading: skeleton tiles plus six skeleton rows.

### Slice 1: a route instead of a sheet, for site roles only

Add a role helper in `apps/web/src/lib/session.ts`, next to the existing ones
(`isAdminLike`, `canScheduleVisits`, ...), with a co-located unit test:

```ts
/** Site-staff surface: these roles document construction progress and never
 *  see money or bookings. */
export function isSiteRole(role: Role | undefined): boolean {
  return role === 'ENGINEER' || role === 'TELECALLER';
}
```

Add the route:
`apps/web/src/app/[orgSlug]/projects/[projectSlug]/site/[unitId]/page.tsx`

Mirror the shell of `inventory/page.tsx` exactly: client component, tenant
context (`useOrgSlug`, `useProjectSlug`), `useSessionUser`, the `mounted` gate
with a page-shaped skeleton, `useParams()` for `unitId`. Data comes from the
existing `useUnit(unitId)` (`hooks/queries/inventory.ts`), which is a plain
`useQuery<UnitRow>`: read `{ data, isLoading, isError }`, and treat
`data === undefined` as "not loaded yet", not "not found".

Then change the entry point. In
`apps/web/src/app/[orgSlug]/projects/[projectSlug]/inventory/page.tsx`, the
row click lives in `tableRowProps.onClick` and calls
`setDetailTarget(row.original)`. Branch there: when `isSiteRole(user.role)`, do
`router.push(projectHref(orgSlug, projectSlug, '/site/' + row.original.id))`
instead. **Do not touch what sales roles see.** `UnitDetailSheet` keeps its
Details + Progress tabs for `canBook` roles unchanged.

Careful: `projectHref` only prefixes the org/project segments for paths whose
first segment is listed in `PROJECT_SCOPED_PATHS` (`apps/web/src/lib/nav.ts`),
so `/site/...` currently resolves to a bare `/site/...` and the link 404s. Add
`'/site'` to that set and extend the existing
`apps/web/src/lib/nav-project-routes.test.ts`
(`isProjectScopedNavPath('/site/abc')` is true, and `projectHref(ORG, PROJ,
'/site/abc')` is `/shadhil-builders/projects/shadhil-metro-heights/site/abc`).

Gate the route: a user without `isSiteRole` gets redirected to `/inventory`.
Do not render a 403 page; they are simply in the wrong place.

### Slice 2: the screen skeleton

One column, phone first, thumb reachable.

- Root: `min-h-dvh flex flex-col bg-background`, no card, no modal chrome, no
  tab bar, no "Close" button (the back chevron is the only exit).
- Sticky header (`sticky top-0 z-20 bg-background/95 backdrop-blur
border-b border-border`), 56px, three items in a row:
  - a 44×44 back button (`LuChevronLeft`, `aria-label="Back to site updates"`)
    linking to the site home URL (`/site`, never `/inventory` - a site role must
    not be able to exit onto the sales grid),
  - the unit title `text-base font-semibold` and underneath it
    `text-xs text-muted-foreground` with `<projectName> · <phaseName>`,
  - the unit status `Badge` (`labelFor('inventory', unit.status)` +
    `inventoryStatusBadgeVariant`, both already exist in `lib/labels.ts`).
- Scrolling content: `flex-1 overflow-y-auto px-4 py-4 space-y-4`, and
  `pb-28` so the sticky bar never covers the last card.
- Sticky bottom action bar:
  `sticky bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur px-4 pt-3`
  with `paddingBottom: max(12px, env(safe-area-inset-bottom))`.
  Inside it, on one row: the primary `Take photo` button `flex-1 min-h-12`
  (h-48px minimum, 16px label, `LuCamera` left icon), and a secondary
  `Gallery` button `min-h-12 min-w-12` variant outline. The camera button owns
  a hidden `<input type="file" accept="image/*" capture="environment">`. The
  gallery button is `FileUploadTrigger` and the whole gallery path is the
  library `FileUpload` component: see Slice 16 for the exact wiring, because it
  is the only upload surface and it carries validation, multi-select and the
  per-file states.
- Above the photo list, a one-line summary derived from real data:
  `8 photos · last added 3 days ago` (`text-sm text-muted-foreground`). Compute
  the relative phrase from `photos[0].takenAt`. Render it only when
  `photos.length > 0`.

### Slice 3: the empty state is the button

When there are no photos, there is exactly ONE thing to tap, and it is the
whole panel. Delete the current button-plus-dashed-box pair. The panel is a
`FileUploadDropzone` (Slice 16), so on desktop it accepts a drop and on a phone
it opens the picker with multi-select; the sticky bar's `Take photo` button
stays the camera path and is always visible.

```
<button type="button">                      // full width, min-h-56, rounded-xl
  circle with LuCamera 24px, 56px diameter   // bg-primary/10 text-primary
  "Add the first photo"                      // text-base font-semibold
  "B-101 has nothing on file yet. Pick photos here, or tap Take photo to shoot one now."
                                             // text-sm text-muted-foreground, max-w-[34ch], centered
                                             // text-sm text-muted-foreground, max-w-[34ch], centered
  3 steps in a row, text-xs, muted, separated by LuArrowRight 12px:
    "Shoot the unit" → "Add a one-line note" → "The customer sees it today"
</button>
```

Style it as a soft surface, not a dashed drop zone:
`border border-border bg-muted-soft hover:bg-muted rounded-xl px-6 py-8
text-center transition-colors focus-visible:ring-2 focus-visible:ring-ring`.
`cursor-pointer`, and a press state (`active:scale-[0.99]`). Keep
`data-qa="progress-empty"` on the whole panel. The old "No photos yet" string
disappears with it, so update the test that greps for that text.

### Slice 4: capture, note, upload

State machine, implemented as one `useReducer` or a few `useState`s in the
route component. Keep every state renderable.

```
idle → file-picked (preview) → note-sheet-open → uploading → saved
                                        ↘ failed (retry in place)
```

1. File chosen: read as base64 (reuse the existing `readAsBase64`) and object
   URL for the preview. Do **not** upload yet.
2. Open a `Sheet` with `side="bottom"` (verify the Prop accepts `'bottom'` in
   the installed types; if it does not, use `Drawer` with the same props shape).
   Header: title `"What did you shoot?"`, description
   `` `Unit ${unit.unitNumber} · ${unit.phaseName}` ``. This is where the old
   "Photos are labelled Phase B" line lives from now on. Delete it from the
   timeline area.
3. Body:
   - the captured photo, `w-full aspect-[4/3] rounded-lg object-cover`, with
     `alt` naming the unit.
   - a quick-note row of chips. Use `ToggleGroup` (`type="multiple"`, `items`)
     with these six labels and values: `Slab`, `Brickwork`, `Plastering`,
     `Waterproofing`, `Flooring`, `Issue`. Selecting a chip **appends its label
     as a line in the textarea** and deselecting removes that line. The
     textarea stays the single source of truth and stays freely editable; the
     chips are a keyboard-free shortcut, not a hidden field. If `ToggleGroup`'s
     props API fights you, fall back to `<Button variant="outline"
aria-pressed>` chips. Add `aria-label="Quick notes"` on the group.
   - a labelled `Textarea` (visible `<label>`, not placeholder-only):
     label `"Note for the team"`, helper `"This is the line the customer reads
in their portal. Keep it short."`, placeholder
     `"Plinth poured, curing until Friday"`, `maxLength={200}`, `rows={3}`,
     and **`className="text-base"`** (16px minimum), because anything smaller
     makes iOS Safari zoom the page on focus, which on a phone looks broken.
     Do not autofocus it.
   - a live counter `{n}/200` in `text-xs text-muted-foreground`, right aligned.
4. Footer: primary `Save photo` (`isLoading={upload.isPending}
loadingText="Saving..."`), secondary `Retake` (ghost). Save is disabled only
   while pending. An empty note is valid: the server falls back to its
   generated caption.
5. Upload: pass the note as `caption` (see Slice 8). On success: close the
   sheet, `toast.success('Photo saved.')`, and invalidate the timeline query.
   Reset all local state so the next capture starts clean.

### Slice 5: the timeline is a photo feed

Replace the 64px-thumbnail rows with cards, newest first, grouped by month with
a heading. Reuse `groupByMonth` and `formatDay` from
`apps/web/src/components/portal/portal-format.ts`. Do not re-implement date
grouping.

One card:

```
<li>                                              // space-y-3
  <button data-qa="progress-photo-row">           // the image is the target
    <img aspect-[4/3] w-full object-cover rounded-lg bg-muted-soft />
    // first 2 eager, rest lazy; width/height set to reserve space (no CLS)
  </button>
  <div class="mt-2 flex items-start gap-2">
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium leading-snug line-clamp-2">   // the NOTE, un-clipped to 2 lines
      <p class="mt-1 text-xs text-muted-foreground">              // "Today, 4:12 pm · Ravi Kumar"
    </div>
    <DropdownMenu trigger={44x44 icon button, LuMoreVertical,
      ariaLabel={`Actions for the photo from ${date}`}}>
      Edit note / Delete photo          // only when photo.canMutate === true
    </DropdownMenu>
  </div>
</li>
```

Rules:

- The note is the visual headline. Never `truncate` it; `line-clamp-2` at most.
- Relative time for today and yesterday, absolute date for older
  (`Today, 4:12 pm` / `Yesterday, 9:05 am` / `3 Nov 2026`). Include the year
  only when it differs from now. Compute it in a small pure helper and unit
  test it.
- No per-row phase chip. The phase is constant per unit and already in the
  header. (Old rows may carry another phase; that is fine, it is not worth a
  chip on every row.)
- Keep `data-qa="progress-photo-thumb"` on the `<img>` and
  `data-qa="progress-photo-row"` on the card so existing selectors survive.
- Move `ProgressPhotoActions` here: keep its edit/delete logic and its
  `canMutate` gate and its `AlertDialog` confirm text exactly, but render it
  from a `DropdownMenu` instead of two naked icon buttons. Do not change the
  mutation calls.
- Plain `<img>`, never `next/image`. The media URL is a same-origin,
  cookie-authenticated BFF route and the optimizer would drop the session.
- "Load more" stays a full-width outline `Button`, keep
  `data-qa="progress-load-more"`, and keep the exact cursor rule (last page
  only).

### Slice 6: the photo viewer

Tapping an image opens a `Dialog` at full screen
(`contentClassName="sm:max-w-none max-w-none w-screen h-dvh p-0 bg-background/98"`):

- the image centered with `object-contain`, `max-h-dvh`.
- a 44×44 close button top right, `aria-label="Close photo"`.
- prev/next 44×44 buttons when there are neighbours, `aria-label="Previous
photo"` / `"Next photo"`, plus ArrowLeft/ArrowRight keyboard handling and
  Escape to close.
- a bottom bar: the note, the full date (`4 November 2026, 4:12 pm`) and the
  uploader.
- do not block native zoom/scroll gestures.

### Slice 7: every state, honestly

- **Loading:** skeleton cards shaped like the real card:
  `aspect-[4/3] w-full animate-pulse rounded-lg bg-muted-soft` plus two text
  bars. Not `h-20` rectangles. Keep `data-qa="progress-skeleton"` and
  `role="status" aria-busy="true" aria-label="Loading photos"`.
- **Uploading:** an optimistic card at the top of the feed with the local
  object URL, `opacity-60`, a spinner overlay and the line `Uploading photo...`.
  On failure it becomes an error card with `Try again` and `Discard`. Do not
  fake a percentage.
- **Upload failed:** inline, in place, not a toast alone:
  `"That photo did not upload. Nothing was saved."` +
  `Try again` (retries the same base64) + `Discard`.
- **Timeline error:** keep the existing inline banner +
  `data-qa="progress-load-retry"`, reworded to
  `"Could not load the photos for this unit."`
- **403 from the timeline:** the documented contract is that a non-member sees
  nothing. On the new route, redirect to inventory and toast
  `"You are not on this project's team."` Do not render a blank screen.
- **No unit found / not yours:** same redirect.
- **Offline:** use the existing `useOnlineStatus` hook
  (`apps/web/src/hooks/use-online-status.ts`, already used by the inventory
  page). When offline, keep the note sheet open, keep the typed note, disable
  Save, and show one honest line: `You're offline. Saving needs a connection.`
  Do not claim the photo is queued for later. `packages/offline-store` exists
  but no `with-offline` wrapper is wired into `apps/web`, so there is no queue
  to fall back on and you must not imply one.

### Slice 8: backend, so the note travels with the photo

This is the one server change, and it is required. Today the caption is
generated after the fact; a client that sends one has it ignored, which is why
the flow in Slice 4 cannot work without this.

`apps/backend/src/customer-progress/customer-progress.service.ts`:

- `UploadPhotoSchema`: add `caption: z.string().trim().min(1).max(200).optional()`.
- In `upload()`, use `const caption = dto.caption ?? buildCaption(phaseOk.name, takenAt);`
  for both the `create` data and the returned DTO, so old clients that omit it
  keep the exact current behaviour.
- No Prisma migration: `ProgressPhoto.caption` already exists.

Extend `apps/backend/src/customer-progress/customer-progress.service.test.ts`:
one case that a supplied caption is persisted and returned, one that an
omitted caption still produces `buildCaption(...)`, one that an empty/whitespace
caption is rejected, one that 201 characters is rejected.

Frontend: add `caption?: string` to `UploadPhotoInput`, and have
`buildPhotoUpload` take it and trim it (`undefined` when empty). Extend
`UnitProgressTab.test.tsx` (or the new test file) to pin: a supplied note lands
in the payload trimmed, and an empty note produces no `caption` key / undefined.

### Slice 9: copy deck

Use these strings. Sentence case, no emoji, no exclamation marks, no em dashes.

| Where                   | String                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Sticky primary          | `Take photo`                                                                                                                   |
| Sticky secondary        | `Gallery`                                                                                                                      |
| Empty hero title        | `Add the first photo`                                                                                                          |
| Empty hero body         | `{unitNumber} has nothing on file yet. Pick photos here, or tap Take photo to shoot one now.`                                  |
| Empty steps             | `Shoot the unit` → `Add a one-line note` → `The customer sees it today`                                                        |
| Note sheet title        | `What did you shoot?`                                                                                                          |
| Note sheet subtitle     | `Unit {unitNumber} · {phaseName}`                                                                                              |
| Note label              | `Note for the team`                                                                                                            |
| Note helper             | `This is the line the customer reads in their portal. Keep it short.`                                                          |
| Note placeholder        | `Plinth poured, curing until Friday`                                                                                           |
| Save                    | `Save photo` / `Saving...`                                                                                                     |
| Retake                  | `Retake`                                                                                                                       |
| Saved toast             | `Photo saved.`                                                                                                                 |
| Uploading card          | `Uploading photo...`                                                                                                           |
| Upload failure          | `That photo did not upload. Nothing was saved.`                                                                                |
| Timeline error          | `Could not load the photos for this unit.`                                                                                     |
| Not a member            | `You are not on this project's team.`                                                                                          |
| Relative time           | `Today, 4:12 pm` · `Yesterday, 9:05 am` · `3 Nov 2026`                                                                         |
| Home title              | `Site updates`                                                                                                                 |
| Stat tiles              | `Needs a photo` · `Updated this week` · `No photos yet`                                                                        |
| Filters                 | `All` · `Needs a photo` · `Updated` · `No photos`                                                                              |
| Home search placeholder | `Find a villa number`                                                                                                          |
| Row meta                | `3 BHK · East · 3 days ago`                                                                                                    |
| State label, fresh      | `Updated today`                                                                                                                |
| State label, week       | `This week`                                                                                                                    |
| State label, stale      | `Needs a photo`                                                                                                                |
| State label, none       | `No photos`                                                                                                                    |
| Home empty              | `No villas on the board yet` / `Units appear here once they are added to a phase of this project.`                             |
| Filter empty            | `Nothing in this filter.`                                                                                                      |
| Cap notice              | `Showing the first 200 units`                                                                                                  |
| Stage picker label      | `Construction stage`                                                                                                           |
| Stage not set           | `Stage not set`                                                                                                                |
| Stage list              | `Not started` · `Foundation` · `Structure` · `Brickwork` · `Plastering` · `Waterproofing` · `Flooring` · `Finishing` · `Ready` |
| Preparing a photo       | `Preparing photo...`                                                                                                           |
| Decode failed           | `This phone cannot read that photo format. Use the camera button instead.`                                                     |
| Wrong type              | `That file is not a JPEG, PNG or WebP image.`                                                                                  |
| Too large               | `That photo is too large to upload.`                                                                                           |
| Not an image            | `That file is not an image.`                                                                                                   |
| Batch too large         | `Pick up to 8 photos at a time.`                                                                                               |
| Batch sheet title       | `{n} photos · Unit {unitNumber} · {phaseName}`                                                                                 |

### Slice 10: accessibility and the QA contract

- Every interactive gets a `data-qa`. Keep every existing value that survives:
  `add-progress-photo`, `progress-empty`, `progress-skeleton`,
  `progress-timeline`, `progress-photo-row`, `progress-photo-thumb`,
  `progress-date`, `progress-caption`, `progress-uploader`,
  `progress-load-more`, `progress-load-error`, `progress-load-retry`,
  `progress-error-banner`, `progress-error-dismiss`, `progress-edit-*`,
  `progress-caption-*`, `progress-photo-edit-*`, `progress-photo-delete-*`.
  New ones: `site-capture-screen`, `site-take-photo`, `site-gallery-button`,
  `site-note-sheet`, `site-note-input`, `site-note-counter`,
  `site-note-chip-{slug}`, `site-save-photo`, `site-retake`,
  `site-photo-open`, `site-photo-viewer`, `site-summary-line`,
  `site-uploading-card`, `site-upload-retry`, `site-upload-discard`.
  For the home page: `site-home`, `site-stat-needs`, `site-stat-week`,
  `site-stat-none`, `site-filter`, `site-unit-search`, `site-phase-group`,
  `site-unit-row`, `site-unit-state-badge`, `site-unit-staleness`,
  `site-home-empty`, `site-home-cap-notice`.
  For the stage: `site-stage-picker`, `site-stage-chip-{value}`, `site-stage-badge`,
  `site-unit-stage`, `portal-stage-stepper`.
  For photo preparation: `site-preparing-photo`.
  For the upload surface: `site-file-upload`, `site-file-dropzone`,
  `site-gallery-trigger`, `site-file-item`, `site-file-progress`,
  `site-file-retry`, `site-batch-sheet`.
- 44×44 minimum for every touch target; 8px minimum between them.
- Visible `focus-visible:ring-2 focus-visible:ring-ring` on every control; never
  remove an outline without replacing it.
- `aria-label` on every icon-only control.
- Images: `alt` names the unit and the note, e.g.
  `Unit B-101, "Plinth poured, curing until Friday"`. Decorative icons get
  `aria-hidden="true"`.
- Announce state changes with one polite live region for
  "Uploading photo..." and "Photo saved."; do not move focus.
- Respect `prefers-reduced-motion`: no transform/slide transitions when set.
- Contrast: 4.5:1 for text, 3:1 for meaningful icons and control borders. Use
  the semantic tokens (`text-foreground`, `text-muted-foreground`,
  `bg-muted-soft`, `--color-success` etc.). No raw hex, no `text-gray-500`.
- Dark mode must work through tokens with no extra conditionals.

### Slice 11: tests

Follow the repo's existing patterns; do not invent a new harness.
`@testing-library/react` is NOT installed in `apps/web`. Use
`renderToStaticMarkup` on extracted presentational components (the same shape
as `portal-timeline.tsx`), and test pure helpers directly.

Required:

1. `isSiteRole`: one test file, ENGINEER/TELECALLER true, every other role and
   `undefined` false.
2. `unitPhotoState(unit, now)`: the boundary cases `photoCount === 0`, exactly 2
   days, 3 days, exactly 7 days, 8 days, and a `lastPhotoAt` in the future. Pass
   `now` in, never read the clock inside the assertion.
3. The relative-time helper: today, yesterday, older date, year boundary, with a
   fixed `now` passed in.
4. The quick-note chip helper (append/remove a line, no duplicate lines, keeps
   order) as a pure function.
5. `buildPhotoUpload`: caption trimmed, empty caption omitted, truncated
   filename, MIME coercion, `takenAt` offset. Keep every existing assertion.
6. The home page, from fixtures: the three counts, the sort puts `stale` first,
   rows group by phase, each filter bucket holds the right rows, the cap notice
   replaces the counts at 200 rows, and the two empty states are different copy.
7. The capture screen's states via `renderToStaticMarkup` on the presentational
   component: empty hero, skeleton, error banner, one card per photo, note as
   headline, no per-row phase chip, load-more only on the last cursor, and the
   403 path rendering nothing (or the redirect contract).
8. Backend: the four `UploadPhotoSchema`/`upload()` cases from Slice 8, and the
   `unit-row.test.ts` update that pins `lastPhotoAt` and `photoCount`.

Delete or rewrite `UnitProgressTab.test.tsx` assertions that pin behaviour you
deliberately changed (the "No photos yet" string, the phase hint line), and say
which in your report.

### Slice 12: optional, only after Slices 1 to 11 are green

For `isSiteRole` users, hide the money columns on the inventory table
(`Per sq.ft price`, `Total sq.ft price`). A site engineer never quotes a price,
and it is noise plus an unnecessary disclosure. Gate it on `isSiteRole` so the
sales view is untouched. Skip this entirely if anything above is red.

### Slice 13: make the note reach somebody

Writing a note that nobody reads is worse than no note, because it looks like
the work is done. Two changes, both small, both required for the feature above
to mean anything.

**13a. The buyer's feed shows the note.** In
`apps/web/src/components/portal/portal-timeline.tsx`, `PhotoRow` renders the
image, a phase chip and a date. The caption exists only inside
`portal/photo-lightbox.tsx`'s dialog description, so the buyer never reads it
without tapping. Render it as the content it is:

- image first, then the caption (`text-base`, `text-foreground`,
  `line-clamp-2`, `mt-2`), then the existing phase and date row below it.
- Skip the element entirely when the caption is empty. Keep the lightbox
  description as it is.
- Extend `portal-timeline.test.tsx` to assert the caption appears in the row
  markup. That is the whole point of the change, so it needs a test that fails
  without it.

**13b. The staff side gets told.** Nothing notifies anybody on the staff side
today. `customer-progress.service.ts` calls `portalNotifier.notifyNewPhoto`,
which resolves buyer ids only. Add the reverse direction.

- **Recipient resolution has to be visibility-independent.** The uploader
  cannot read other people's photo-lead rows: `project_staff_role_select_own_or_admin`
  allows own rows or ADMIN, and `Team` reads are scoped to their own teams. So
  add a `SECURITY DEFINER` helper to `packages/database/prisma/rls/policies.sql`
  plus the migration that applies it, mirroring `unit_customer_user_ids`:

```
project_site_update_recipient_ids(p_project_id TEXT) RETURNS SETOF TEXT
```

returning the distinct, soft-delete-excluded user ids of:

- every `ProjectStaffRole` row for that project with `kind = 'PHOTO_LEAD'`,
- every `Team.managerId` for a team linked to the project through
  `ProjectTeam`.
  `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO shadhil_app`, same as
  the existing helpers.

- **A notifier service beside PortalNotifier.** New
  `apps/backend/src/customer-progress/site-update-notifier.service.ts`, same
  shape as `customer-portal/portal-notifier.service.ts`: injected
  `PrismaService` and `NotificationsService`, a fixed system identity for the
  recipient query (copy `PORTAL_NOTIFIER_USER_ID` and the `CRON_SERVICE` role
  from PortalNotifier), a `notifyNewPhoto`-style method that never rejects and
  logs its own failures. Call `notifications.emit(recipientId, {...})` once per
  recipient, skipping the uploader.

- **One notification per unit per day, not one per photo.** An engineer shoots
  six angles of one villa and a manager must not get six pings. Before the
  insert in `upload()`, count today's photos for that unit (the actor can read
  them) and only notify when the count is zero.

- **Payload.** `type: 'progress.photo'`,
  `title: 'New site photo on ' + unitNumber`,
  `body: '<uploader name>: <caption>'` clamped to 120 characters,
  `organizationId` set explicitly. No `leadId`. Fire it after the row commits,
  outside the `try` block, the same way the portal notifier is fired, so a
  notifier fault can never trigger the blob compensation delete.

- **`Notification` needs a `unitId` or the inbox will swallow it.**
  `NotificationsService.list()` narrows an active `projectId` to
  `leadId IN (project's lead ids)`, and the notifications page always passes
  the active project, so a notification with no lead is invisible. Add
  `unitId String?` plus `@@index([unitId])` to the `Notification` model, a
  migration, `unitId` on the emit payload and the wire row, and change the
  project narrowing to
  `OR: [{ leadId: { in: leadIds } }, { unitId: { in: projectUnitIds } }]`
  (one extra `unit.findMany` in the same RLS context; nothing else in that
  `where` uses a top-level `OR`, so there is no clobber risk). A notification
  with neither a lead nor a unit stays hidden under a project filter, which is
  the documented behaviour; pin it with a test.

- **The inbox renders it.** `apps/web/src/app/[orgSlug]/projects/[projectSlug]/notifications/page.tsx`
  prints `· ${row.type}` raw. Add a small label map with a fallback to the raw
  string (`progress.photo` → `Site photo`), and add a `SITE` filter button with
  `typePrefix: 'progress'` next to Leads, Bookings and Visits.

- **No push deep link in this slice.** `PushService`'s payload carries lead and
  booking ids only, so the body names the unit and tapping opens the app. Do not
  invent a `unitId` push field; if you want it, that is its own change.

Tests for 13b: recipients come from the helper and the uploader is excluded; a
second photo on the same unit today emits nothing; a notifier failure does not
fail the upload; `emit` is called with `organizationId` and `unitId`; and
`NotificationsService.list()` shows a unit notification under the active project
and hides a notification that has neither a lead nor a unit.

Editing a caption later does not notify anybody. Do not add that.

### Slice 14: the construction stage, which is what "status of the house" means

The engineer is asked to record the state of the build and the only place to put
it today is 200 free-text characters on a photo. Add a real stage.

**Put it on the photo, not on the unit.** The engineer's write authority is
already `ProgressPhoto` (INSERT/UPDATE/DELETE scoped to their project teams),
while `Unit` is read-only for them: `unit_select_team_member` has no write arm.
A stage column on `Unit` would need a new RLS policy and would lose history. On
the photo it needs neither, and the progression comes free. The unit's current
stage is derived from its newest photo and is never denormalized.

Backend:

1. `packages/database/prisma/schema.prisma`: add the enum, declaration order is
   the progress order and must not be re-sorted later:

```
enum ConstructionStage {
  NOT_STARTED
  FOUNDATION
  STRUCTURE
  MASONRY
  PLASTERING
  WATERPROOFING
  FLOORING
  FINISHING
  READY
}
```

and `ProgressPhoto.stage ConstructionStage?`.

2. A migration in `packages/database/prisma/migrations/` that creates the type
   and adds a nullable column with no default and no backfill, matching the
   style of the existing enum migrations. Existing rows stay NULL, which means
   "not recorded", not "not started".

3. `packages/api-types/src/enums.ts`: `ConstructionStageSchema` plus its type,
   next to `UnitStatusSchema` and friends. Read the `zod` skill before you write
   it; that is a standing rule in this repo, and the project is on zod 4.

4. `UploadPhotoSchema`: `stage: ConstructionStageSchema.optional()`. Optional
   forever, so old clients and old photos keep working.

5. `UpdatePhotoSchema` currently requires a caption, so a stage-only correction
   would 400. Make both fields optional and refine that at least one is present,
   keeping `caption` non-empty and capped at 200 when supplied.

6. `progress-photo.mapper.ts`: add `stage: string | null` to
   `TimelinePhotoDto` and map it through. Null when unset.

7. Unit row: extend the relation select added in Slice 0 to also select
   `stage`, and expose `lastPhotoStage` on `UnitRow` (api-types schema, the web
   mirror type, and `toUnitRow`). Null when the newest photo has no stage.

Frontend:

8. `apps/web/src/lib/labels.ts`: `CONSTRUCTION_STAGE_LABELS` (NOT_STARTED →
   `Not started`, FOUNDATION → `Foundation`, STRUCTURE → `Structure`, MASONRY →
   `Brickwork`, PLASTERING → `Plastering`, WATERPROOFING → `Waterproofing`,
   FLOORING → `Flooring`, FINISHING → `Finishing`, READY → `Ready`),
   `CONSTRUCTION_STAGE_ORDER` (the enum order, for the stepper), a
   `constructionStageLabel()` and a `constructionStageBadgeVariant()`. Extend
   `labelFor` with a `'constructionStage'` kind. Add the describe block to
   `labels.test.ts` in that file's existing style, covering all nine values.

9. The note sheet gets a stage picker above the note: a single-select
   `ToggleGroup` of chips in enum order, horizontally scrollable, 44px minimum
   height, `aria-label="Construction stage"`. It defaults to
   `unit.lastPhotoStage`. When the unit has no staged photo, nothing is
   preselected: never default to `NOT_STARTED`, that is a guess dressed as data.
   The chosen stage rides along with Save.

10. `buildPhotoUpload` takes `stage` and omits the key entirely when unset.
    `UploadPhotoInput` gains `stage?: ConstructionStage`.

11. Capture screen header: the stage as a `Badge` beside the unit status.
    Muted "Stage not set" when null.

12. Home row meta becomes `Structure · 3 days ago`. The staleness colour stays on
    the media square and the state badge; the stage is text, not another colour.

13. The buyer's portal gets a stage stepper above the timeline: nine segments in
    enum order with the current one filled, and the current stage named beside
    it. Each photo entry also carries its stage, small and muted, next to the
    date. Do not print a percentage: "62% complete" would be invented, and this
    product does not lie about progress.

Rules:

- A stage can go backwards. Rework happens. The newest photo wins and nothing
  validates forward-only.
- Old photos keep a NULL stage forever. Every surface says `Stage not set`,
  never `Not started`.
- Correcting a caption must never clear the stage, and correcting a stage must
  never clear the caption. That is why the PATCH schema is partial.
- Enum declaration order is the only order. Never sort stages alphabetically,
  and never hardcode a stage list in a component; import it from `labels.ts`.

Tests: the label, order and badge helpers; `buildPhotoUpload` with and without a
stage; the upload schema accepting every value and rejecting an unknown string;
the PATCH schema accepting stage-only, caption-only, both, and rejecting
neither; the mapper mapping NULL and a set value; `toUnitRow` deriving
`lastPhotoStage` from the newest photo; the portal stepper marking the right
segment; and `labels.test.ts` covering all nine.

### Slice 15: HEIC and photo size, fixed at the source

Read this before touching the upload. The server is already strict, and that is
not the problem:

`apps/backend/src/storage/sniff-mime.ts` sniffs the leading bytes,
`upload()` calls `reconcileUploadMime(buf, dto.mimeType)` at
`customer-progress.service.ts:164`, and a HEIC or AVIF payload is rejected with
an actionable 400. Nothing is stored with the wrong type. Do not weaken the
sniffer, do not add an allowlist bypass, and do not make HEIC acceptable
upstream. If `apps/backend/src/storage/` already has a sniff test covering the
`heic` brand at offset 8, add nothing there.

The defect is on the client. `normalizeMimeType` in
`UnitProgressTab.tsx` only relabels the declared type to `image/jpeg` for
anything that is not png or webp, and the server then ignores that label and
reads the bytes. So an iPhone shooting HEIC gets a 400 telling the engineer to
go change a phone setting, standing in a half-built villa. The plan's own
normaliser (`packages/offline-store/src/photo-normalize.ts`) exists precisely
for this and the progress path never calls it.

**15a. Extend the normaliser, do not fork it.**

`packages/offline-store` is consumed from source (`main` and `types` point at
`./src/index.ts`), so an edit is visible to `apps/web` with no build step.

- `normalizeToWebP(blob, quality = 0.85, options?: { maxEdge?: number }): Promise<Blob>`.
  Omitting `options` keeps today's exact behaviour, because the offline
  lead-form path calls it with two arguments.
- `OffscreenCanvas` where available, falling back to a DOM canvas and `toBlob`.
  Safari before 16.4 has no `OffscreenCanvas`, and the current implementation
  throws a ReferenceError there.
- Downscale so the long edge is at most `maxEdge`. Extract the arithmetic into a
  pure `fitWithin(width, height, maxEdge)` and unit test it: wide, tall, square,
  already smaller than the cap (never upscale), and the exact boundary.
- Document the trap: a browser with no WebP encoder silently returns a PNG from
  `convertToBlob`/`toBlob`. The caller must read `blob.type`, never assume
  `image/webp`.

**15b. One wrapper the capture flow can call.**

New `apps/web/src/lib/photo-prep.ts`:

```
prepareProgressPhoto(file, { source: 'camera' | 'gallery' }): Promise<PreparedPhoto>
PreparedPhoto = { base64, mimeType, filename, takenAt, source, byteLength, width, height }
```

- Convert with `normalizeToWebP(file, 0.82, { maxEdge: 1600 })`.
- Map the RESULT type onto the server allowlist. Anything outside
  `image/webp | image/jpeg | image/png` is an error, not an upload.
- `filename` is the original stem plus the extension that matches the real
  type. A `.HEIC` name over WebP bytes is the mismatch this slice exists to
  kill.
- `takenAt` stays `file.lastModified`. EXIF capture time is a separate item;
  do not touch it here.
- Three typed errors, no fallback path: `decode_failed`,
  `unsupported_output`, `too_large` (over 10MB after conversion, which means
  the conversion did not happen).
- Export the pure bits (`extensionForMime`, `fitWithin`) so they are testable
  without a canvas.

**15c. The capture flow uses it.**

- File chosen, then `prepareProgressPhoto`, then the preview, then the note
  sheet. Preview the blob that will actually upload, never the original.
- While it runs show `Preparing photo...` with a spinner. A 12MP conversion takes
  100 to 400ms on a mid-range phone.
- The upload sends `prepared.mimeType` and `prepared.filename`, and
  `clientDeviceHint` comes from whichever input was used.
- Delete `normalizeMimeType` from `UnitProgressTab.tsx`. It is now a lie that
  costs a round trip.
- On a typed error, close nothing and upload nothing: `toast.error` with one of
  these, and let tsc prove there is no other path.
  - `decode_failed`: `This phone cannot read that photo format. Use the camera button instead.`
  - `unsupported_output`: `That file is not a JPEG, PNG or WebP image.`
  - `too_large`: `That photo is too large to upload.`

**15d. The size win is the point.** A 12MP photo becomes a 1600px WebP, typically
200 to 400KB instead of 2 to 5MB of base64. That is what makes the upload
survive site signal, and it is why the conversion is worth the 200ms.

Tests: `fitWithin` (five cases above); `extensionForMime`; `prepareProgressPhoto`
with `normalizeToWebP` mocked, covering the happy path and all three typed
errors; `buildPhotoUpload` keeps every existing assertion and takes the prepared
values; and a check that nothing still imports `normalizeMimeType`.

Rules:

- No new dependency. No sharp, no heic2any, no exifr.
- Do not resize the long edge below 1600px. The lightbox is full screen and the
  feed crops to 4:3.
- Do not move the conversion into a Web Worker. The file is picked once and a
  short stall on tap is acceptable; the package's own comment says the same.
- Do not silently fall back to uploading the original bytes when conversion
  fails. Failing loudly is the entire point of the change.

### Slice 16: the upload surface is the library `FileUpload`

Every photo that enters this system goes through
`@paalstack/react-ui`'s `FileUpload`. Read the props in
`node_modules/@paalstack/react-ui/dist/index.d.ts` (search `interface FileUploadProps`)
before writing it. The shape, verified against 1.7.2:

```
<FileUpload
  accept="image/*"
  maxFiles={8}
  maxSize={10 * 1024 * 1024}          // matches MAX_UPLOAD_BYTES on the server
  multiple
  dir="ltr"
  onFileValidate={(file) => (file.type.startsWith('image/') ? null : 'That file is not an image.')}
  onFileReject={(file, message) => toast.error(message)}
  onValueChange={(files) => void startCapture(files)}
>
  <FileUploadDropzone>...</FileUploadDropzone>
  <FileUploadTrigger asChild><Button variant="outline">Gallery</Button></FileUploadTrigger>
  <FileUploadList orientation="vertical">
    {files.map((file) => (
      <FileUploadItem key={file.name + file.lastModified} value={file}>
        <FileUploadItemPreview />
        <FileUploadItemMetadata size="sm" />
        {/* our own status text: Preparing / Uploading / Saved / Try again */}
        <FileUploadItemDelete />
      </FileUploadItem>
    ))}
  </FileUploadList>
  <FileUploadClear />
</FileUpload>
```

Two props you will deliberately NOT use, and why:

- `onUpload(files, { onProgress, onSuccess, onError })` drives the component's
  own progress and status. Our flow needs the note BEFORE anything is sent, so
  the upload is driven by our own queue after the sheet is saved. That means
  `FileUploadItemProgress` has nothing real to report, so do not render it and
  render your own status text instead. A progress bar stuck at 0 is worse than
  no progress bar.
- `onValueChange` is the only callback that starts our flow. `onAccept` and
  `onFileAccept` fire per file and would open the note sheet once per file,
  which is exactly the behaviour the batch rule below removes.

**The camera button does not go through FileUpload, and that is deliberate.**
`FileUploadProps` extends `ComponentProps<'div'>` and exposes `accept`,
`multiple`, `maxFiles`, `name`, `required`. It does not expose `capture`, and
the file input is internal, so there is no supported way to force the camera.
Without `capture="environment"` an iPhone shows the Library / Take Photo sheet
and costs the engineer an extra tap on every single capture. So:

- `Take photo` (the sticky primary action) keeps a plain hidden
  `<input type="file" accept="image/*" capture="environment">`. One tap, camera
  opens, done.
- `Gallery`, the desktop drop zone, and the empty-state panel all run through
  `FileUpload`. That is where validation, rejection messages, multi-select and
  per-file state actually earn their keep.

**Multi-select is now real, and it changes the note step.** One visit is six
angles of the same villa. `multiple` means the engineer picks six files at once
and writes ONE note and ONE stage for the batch:

1. `onValueChange` hands you `File[]`. Prepare every file with
   `prepareProgressPhoto` (Slice 15). If any file fails, say which and upload
   none of them; a partial batch is a mess to explain later.
2. Open the note sheet once, header `6 photos · Unit B-101 · Phase B`, with the
   same stage picker and the same single note. The note applies to all of them.
3. On save, upload SEQUENTIALLY, one POST per photo, in the order picked. Not in
   parallel: six parallel multipart bodies over site signal will all time out
   together. Each item shows its own state in `FileUploadList`
   (`preparing`, `uploading`, `saved`, `failed`) and a failed one offers
   `Try again` without re-sending the ones that already landed.
4. The single-photo camera path behaves exactly as Slice 4 describes: one file,
   same sheet, same fields.

**Do not invent progress.** `onUpload` gives you `onProgress(file, n)`, but our
client is `fetch`-based and `fetch` has no upload progress events. Report three
real states (preparing, uploading, saved) and keep the progress bar
indeterminate with `forceMount` so the row does not jump when it flips. A
number that climbs on a timer is a lie and the engineer will learn to ignore it.

**Validation lives in the component, not in a hand-rolled guard.** `maxSize`
10MB, `maxFiles` 8, `accept="image/*"`, and `onFileValidate` returning a string
for anything that is not an image. `onFileReject` turns that string into one
`toast.error`. HEIC must pass validation, because the conversion in Slice 15 is
what makes it acceptable; rejecting it at the picker would remove the fix.

Wire `clientDeviceHint` from the entry point: `'camera'` for the capture input,
`'gallery'` for everything that comes through `FileUpload`.

Tests: `onFileValidate` rejects a non-image and accepts HEIC; the batch path
prepares every file and opens one sheet; a failed preparation uploads nothing;
sequential ordering (the second POST does not start until the first resolves);
and one failed item leaves the successful ones saved.

## Components: Item or Card, and where each goes

Verified against `@paalstack/react-ui` 1.7.2. Read `dist/index.d.ts` before you
write either; do not guess a prop.

- `Item`, `ItemGroup`, `ItemSeparator`, `ItemMedia`, `ItemContent`,
  `ItemTitle`, `ItemDescription`, `ItemActions`, `ItemFooter`.
  `Item` extends `BoxProps`, so it accepts `bg` / `textColor` / `borderColor`
  from the library's 30-name palette, plus `variant="default|muted|outline"`
  and `size="default|xs|sm"`. `asChild` is supported, which is how a row becomes
  a `<Link>`.
- `Card`, `CardRoot`, `CardHeader`, `CardTitle`, `CardDescription`,
  `CardAction`, `CardContent`, `CardFooter`.

Rule, applied without debate:

| Thing                                                            | Component                                                        | Why                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| A unit in a list of 20 to 200, where the whole row is one action | `Item`                                                           | Dense, scannable, one tap target, dividers instead of card borders |
| A phase group on the home page                                   | `CardRoot` + `CardHeader` + `CardContent` holding an `ItemGroup` | The group is one surface with a heading; the rows inside are rows  |
| A stat tile                                                      | `Box` or `CardRoot` with a tint                                  | One number, one label, no internal list                            |
| One photo entry in the capture feed                              | `CardRoot` with the image edge to edge, then content             | A self-contained object, not a row in a list                       |
| The first-photo hero                                             | `CardRoot`, whole card is the button                             | It is content, not chrome                                          |

Never nest a `Card` inside an `Item`. Never use `Card` for a repeated list of
more than ten items: padding and borders turn into noise and the page gets
twice as tall for half the information.

## Colour: four states, not a rainbow

A construction tool painted in six accent hues reads as a toy, and the one
person using it outdoors in sunlight cannot decode decoration. So: more colour
than today, but every hue answers the question the engineer actually asks,
which is which villa have I not been to yet.

Four documentation states, each derived from a real timestamp:

| State   | Rule                        | Badge variant | Surface tint                              |
| ------- | --------------------------- | ------------- | ----------------------------------------- |
| `none`  | `photoCount === 0`          | `muted`       | `bg-muted-soft`, `text-muted-foreground`  |
| `today` | `lastPhotoAt` within 2 days | `success`     | `bg-success-soft`, `text-success-soft-fg` |
| `week`  | 3 to 7 days                 | `info`        | `bg-info-soft`, `text-info-soft-fg`       |
| `stale` | more than 7 days            | `warning`     | `bg-warning-soft`, `text-warning-soft-fg` |

Sort order is the work queue: `stale`, then `none`, then `week`, then `today`.
Compute the state in one pure helper (`unitPhotoState(unit, now)`) and unit test
it at the boundaries: 0 photos, 2 days, 3 days, 7 days, 8 days, a future
timestamp.

Where colour is allowed:

- The row's `ItemMedia` square and the row's `Badge`. Nowhere else on the row.
- The stat tiles, one tint each, same four tokens.
- The phase rail: a 4px left border in a phase accent, cycling `sky`, `violet`,
  `teal`, `amber` by the phase's index. This is the only decorative colour in
  the product, it is stable per phase, and it stays on the rail and the phase
  heading.
- The capture screen stays mostly monochrome because the photos are the colour.
  One exception: the header pill repeating the unit's state, same tint.

Not negotiable:

- Semantic tokens and the library's `bg` / `textColor` / `borderColor` props
  only. No `bg-amber-50`, no hex, no `text-gray-500`.
- Every state carries a label or an icon as well as a colour. Colour alone
  fails WCAG 1.4.1 and fails a colour-blind engineer on site.
- Contrast: 4.5:1 for text, 3:1 for icons and borders, in both themes. If a
  status pair fails on the tint you pick, fix the pair in
  `packages/ui-tokens/src/brand.css` and update `SHADHIL_AA_OVERRIDES` in
  `packages/ui-tokens/test/compliance.test.ts`. Do not bypass that test.
- Dark mode comes from the tokens. Do not add `dark:` overrides; fix the token
  if a dark value is wrong.
- Four hues maximum on one screen. A fifth means the design is wrong.

## Guardrails

- Do not add a dependency. Everything needed is in `@paalstack/react-ui`
  (Sheet, Drawer, Dialog, Tabs, Badge, Button, Textarea, ToggleGroup,
  DropdownMenu, AlertDialog, Empty, Avatar, Skeleton, Spinner, Progress) and
  `@paalstack/react-icons/lu`.
- Do not use `next/image` for BFF media URLs.
- Do not invent a backend field, a mock row, a fake count or a placeholder
  success. Empty means empty.
- Do not hand-roll role checks; use `isSiteRole` and the existing helpers.
- Do not touch RLS, the mutation authority model, or the server's
  edit/delete predicate.
- Do not change what `canBook` roles see in `UnitDetailSheet`.
- Do not add a colour outside the four-state map and the phase rail.
- Do not put the stage on `Unit`. It belongs to a capture, and the newest
  capture is the current stage.
- Do not sort the site list by unit status, availability or price. Those are
  sales facts and the engineer's order is by neglect.
- Do not run the root `pnpm build` (it OOMs this repo). Use
  `pnpm --filter web build` and the per-app commands.
- Do not commit, push or open a PR.

## Definition of done

1. `pnpm --filter web test`, `pnpm --filter web lint`,
   `pnpm --filter web type-check` all green. Backend package the same for the
   DTO change.
2. Both pages work with real data. As an ENGINEER: the home page lists the
   project's villas with real counts and real state labels, a stale villa sorts
   first, and tapping one opens the capture screen. Take a photo, type a note,
   save, and the note comes back from the server as the card's headline after
   the invalidation. The home page row for that unit drops back to
   `Updated today` on the next visit.
3. Checked at 375×667, 390×844 and 1440×900. No horizontal scroll at 375. The
   primary action is reachable with a thumb and never covered by the safe area.
4. Dark mode and light mode both checked; reduced-motion checked.
5. Every state in Slice 7 renders without a runtime error, including the
   failure paths.
6. Accessibility: keyboard-only pass through home → capture → note → save, and
   one screen-reader pass over both pages.
7. Colour check: screenshot the home page and desaturate it. The four states
   must still be distinguishable, because each one also carries a label and an
   icon. If two states look identical in greyscale, the labels are doing all the
   work and the colour is decoration, so change it.
8. Zero-photo project: open the home page on a project with no photos at all and
   confirm every number on it is a real zero, not a placeholder.
9. The buyer's feed shows the note under the photo without a tap, and the lightbox
   still shows it.
10. Upload one photo as an ENGINEER and confirm the project's photo lead and the
    team manager each get exactly one in-app notification, it survives the
    active-project filter on the notifications page, and a second photo on the
    same unit that day sends nothing.
11. A stage set at capture appears on the home row, the capture header and the
    portal stepper. A stage-only PATCH corrects it without wiping the note, and a
    caption-only PATCH leaves the stage intact.
12. A unit whose newest photo has no stage reads `Stage not set` everywhere and
    never `Not started`.
13. An iPhone HEIC photo, from either the camera button or the gallery picker,
    uploads and renders in the buyer portal. Confirm the stored row's mimeType is
    `image/webp` and the filename ends `.webp`.
14. Watch the network panel: a 4MB original produces a payload of a few hundred
    kilobytes, not megabytes.
15. A file the browser cannot decode shows one plain sentence and uploads
    nothing. No row, no blob, no half state.
16. Drag four images onto the empty-state panel on desktop: one sheet opens with
    `4 photos · Unit ...`, one note and one stage save all four, they upload in
    order, and each row reports its own state.
17. Pick a PDF through the gallery button: one toast says `That file is not an
image.` and nothing is prepared.
18. Tap `Take photo` on a phone and confirm the camera opens directly, not the
    library sheet. This is the check that keeps the native input honest.

## Report format

When you finish, give me: files added and changed; the tests you added and the
ones you rewrote; anything you could not verify locally and why; and the exact
commands you ran with their results. No summary of what the feature does, I can
read the diff.

--- END PROMPT ---
