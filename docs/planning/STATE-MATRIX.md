# State matrix - every page × every state

**T-D3 (Plan D3+D5).** Single source of truth for which component a
surface renders in each state. When a page grows a new state branch
(e.g. a `RATE_LIMITED` error), the table is updated in lockstep
with the code change so the contract is auditable.

**Verify:** `pnpm -r --filter @shadhil/web test` passes 4-state
assertions for every page below. Playwright sweep (T-D3 part 2,
future work) drives the same matrix against a live server.

## The four states

Every data-driven page must handle:

| State | Component | When |
|---|---|---|
| **loading** | `<Skeleton variant="text">` (or `variant="user"` for the topbar user slot) | The query's `isLoading === true`. |
| **empty** | Page-local empty message (e.g. "No pending contacts.") with a data-qa hook | Query resolved successfully, `data` is an empty array / `total === 0`. |
| **error** | `<ModulePending error={...}>` | Query's `error !== null`. The page may also show a `ToastProvider` toast. |
| **partial** | The full list view (no special wrapper) | Query resolved with at least one row. `Skeleton` is NOT shown while `data` exists, even on refetch. |

`ModulePending` is the canonical "broken" surface - it covers
loading, error, and not-yet-built-module states (see
`components/shared/ModulePending.tsx`). Pages that depend on a
module that hasn't shipped yet (e.g. T-D8 visits before the
visits backend landed) use ModulePending as the universal
fallback.

## SSE connection state (T-D3 part 5, D5)

The topbar's `SseStatusPill` exposes the live EventSource
state. Three visual states, all in the topbar (next to the
notification bell):

| State | Color | Label |
|---|---|---|
| connecting | amber | "Reconnecting..." (during reconnect) |
| open | green | nothing (hidden when connected) |
| closed | red | "Offline" (after retry exhaustion) |

The pill has its own data-qa hook (`data-qa="sse-status-pill"`)
and the test in `SseStatusPill.test.tsx` pins all three states.

## Per-page state matrix

Each (page, state) row pins: the data-qa hook to assert, the
expected text/element, and the test file that covers it.

| Page | Hook | Loading | Empty | Error | Partial | Test file |
|---|---|---|---|---|---|---|
| `/` (dashboard) | TBD | TBD | TBD | TBD | TBD | _none - dashboard uses placeholder widgets_ |
| `/leads` | `data-qa="lead-inbox"` | `<Skeleton>` rows | "No leads" | `<ModulePending>` | full list table | _none - see T-D3 vitest addition_ |
| `/leads/new` | `data-qa="lead-form"` | _n/a (form)_ | _n/a_ | field-level errors + `<ToastProvider>` | success → `/leads/{id}` | _none - see T-D3_ |
| `/leads/[id]` | `data-qa="lead-detail"` | `<Skeleton>` | "Lead not found" + 404 | `<ModulePending>` | full detail layout | _none - see T-D3_ |
| `/visits` | `data-qa="visits-list"` | `<Skeleton>` | "No visits scheduled" | `<ModulePending>` | full list table | _none - see T-D3_ |
| `/inventory` | `data-qa="inventory-list"` | `<Skeleton>` | "No inventory" | `<ModulePending>` | full list | _none - see T-D3_ |
| `/users` | `data-qa="users-list"` | `<Skeleton>` | "No users" | `<ModulePending>` | full list | _none - see T-D3_ |
| `/notifications` | `data-qa="notification-row"` | `<Skeleton>` | "No notifications yet" | `<ModulePending>` | list of `notification-row` | `notifications/page.test.tsx` |
| `/audit` | `data-qa="audit-list"` | `<Skeleton>` | "No audit entries" | `<ModulePending>` | full audit list | `audit/page.test.tsx` |
| `/bookings` | `data-qa="bookings-list"` | `<Skeleton>` | "No bookings" | `<ModulePending>` | full list | `bookings/page.test.tsx` |
| `/bookings/new` | `data-qa="booking-form"` | _n/a (form)_ | _n/a_ | field-level errors | success → `/bookings` | `bookings/new/page.test.tsx` |
| `/whatsapp-unknown-contacts` | `data-qa="wa-unknown-list"` | `<Skeleton>` | "No pending contacts" / "No converted contacts" / "No spam-marked contacts" | `<ModulePending>` | full list | `whatsapp-unknown-contacts/page.test.tsx` |

The 7 "none" rows are gaps. T-D3 closes the largest 4: leads
list, leads/[id] detail, users, visits. (inventory + bookings-new
already have partial coverage; the rest are stretch.)

## Skeleton / ModulePending contract

`Skeleton` is the loading state. From `components/shared/Skeleton.tsx`:
- `variant="text"` - line-shaped placeholder; one per row of
  expected content.
- `variant="user"` - avatar + 2 text lines; for the topbar user slot.
- No `isOffline` prop on the per-page Skeletons (offline-state
  handling lives in the topbar `OfflineQueueBadge` and the
  `useOnlineStatus` hook in shared layouts).

`ModulePending` is the error / not-yet-built state. It takes
`error: unknown` (any caught error from react-query) and renders
a "failed to load: ..." card. Pages that depend on unbuilt modules
also use this as a no-data placeholder.

## Pattern: query → state mapping

The shared pattern (used in every page; copied from
`notifications/page.tsx`):

```ts
const q = useNotifications({ unreadOnly: filter === 'UNREAD' });
const rows = q.data?.rows ?? [];
const total = q.data?.total ?? 0;
const isError = q.error !== null && q.error !== undefined;

if (q.isLoading) return <Skeleton variant="text" />;
if (isError) return <ModulePending error={q.error} title="..." />;
if (rows.length === 0) return <Empty />;
// partial: render the full list view
```

The `Skeleton` lives in the page (not ModulePending) so the
loading state can match the eventual content's shape (text
rows, user cards, etc.).

## What ships in T-D3

1. **This document** - the state matrix above.
2. **Vitest 4-state assertions for the 4 largest gaps**: leads
   list, leads/[id] detail, users, visits. Each new test pins
   the same 4 cases (loading / error / empty / partial) using
   the existing `vi.mock` pattern from `notifications/page.test.tsx`.
3. **data-qa hooks** added to the 4 gaps so the assertions can
   target the right elements (the existing pages don't all have
   hooks; adding them is a 1-line change per page).

## Future work (T-D3 part 2 - not in this commit)

A Playwright e2e sweep that drives every page × every state
matrix cell against a live server. The hooks added in this
commit + the per-page vitest coverage make that sweep
straightforward when the time comes.
