# Shadhil CRM — Authenticated App Shell Redesign Plan

**Source:** `/plan-design-review` skill invocation, 2026-09-03
**Scope:** Full redesign (user picked option **B** from D1): sidebar + charts + mobile polish + non-tech copy in one PR.
**Branch:** working tree of `~/workspace/shadhil-projects/shadhilbuilders-crm`, HEAD `c1118a7`, no PR open
**Reviewer verdict:** Plan-design-review complete. 7 passes executed; design score 3/10 → target 8/10 after this plan implements the additions.
**Locked design decisions from this review:**
- D2: **Friendly labels everywhere** — engineering enums get human-friendly UI names; server still stores the enum.
- D3: **Role-tuned default** — each role's Dashboard shows charts relevant to their work.
- D4: **Floating "+ Add lead" CTA** on `/leads` and `/leads/[id]`, role-gated (telecaller/exec/manager+).

---

## 1. Background & rationale

The authenticated CRM shell currently has a flat horizontal top-nav (`AppHeader`) and a Dashboard with a KPI strip + three `ModulePending` placeholders. The user's brief (verbatim, 2026-09-03):

> use agency_agents_search i want you change the layout of crm, i prefer sidebar use sidebar from @paalstack/react-ui package and add more charts use charts components from @paalstack/react-ui, i want to support the ui both mobile and web, first preference is mobile friendly use company logo and icons properly. the ui needs to be neat and nice, even non-technical person should easily understand the ui without any explanation.

The redesign converts the shell to a **persistent desktop sidebar + mobile sheet** pattern, **adds role-tuned charts**, **adopts the brand logo + icon set**, and **rewrites user-facing copy** to be readable by sales staff without engineering context. All five asks ship in one PR; reviewability is preserved by feature flags on the larger chart surfaces.

---

## 2. Pre-review system audit (recap)

- **DESIGN.md exists** at `docs/planning/DESIGN.md` (v3, 1069 lines) — all role/permission/label decisions below cite it.
- **Existing design leverage:**
  - `SidebarProvider` / `Sidebar` / `SidebarInset` from `@paalstack/react-ui` ^1.4.1 — full shadcn parity, built-in mobile sheet at ≤768px, Ctrl/Cmd+B shortcut, cookie-persisted open state.
  - `Chart` wrapper + `BarChart` / `LineChart` / `AreaChart` / `PieChart` via recharts.
  - `ModulePending` (`apps/web/src/components/shared/ModulePending.tsx`) — honest "module not built yet" pattern with loading/error/empty. **Every chart must use this until its backend module ships.**
  - `KpiStrip` pattern (locked decision, `apps/web/src/app/(app)/page.tsx`) — numbers in a row, not card grid.
  - Role helpers (`isAdminLike`, `canManageUsers`, `canViewAudit`, `canScheduleVisits`, `canApproveBookings`) in `apps/web/src/lib/session.ts`.
  - `OfflineQueueBadge`, `OnlineRevalidationBar`, `install-prompt.tsx` — relocate with the layout.
- **Retrospective:** No `reviews.jsonl`; only the offline-queue-badge placement decision (Design review 2A, per `app-header.tsx` line 113) is referenced. Be opinionated about visual hierarchy + non-tech copy because both have been implicit decisions.

---

## 3. Pass 1 — Information Architecture

### 3.1 Desktop (≥768px)

```
SidebarProvider
├── Sidebar (collapsible="icon", default expanded, variant="inset")
│   ├── SidebarHeader
│   │   ├── Logo: <Image src="/brand/logo.png" /> (h-7 w-7 mr-2) + "Shadhil CRM" wordmark
│   │   └── SidebarTrigger (mobile only, hidden md+)
│   ├── SidebarContent
│   │   ├── SidebarGroup label="Work"
│   │   │   └── SidebarMenu
│   │   │       ├── SidebarMenuItem → Dashboard (LuLayoutDashboard)
│   │   │       ├── SidebarMenuItem → Leads (LuUsers)         + Badge(count)
│   │   │       ├── SidebarMenuItem → Visits (LuCalendarDays)
│   │   │       ├── SidebarMenuItem → Inventory (LuPackage)
│   │   │       └── SidebarMenuItem → Notifications (LuBell)  + Badge(unread)
│   │   ├── SidebarSeparator (admin-class only)
│   │   └── SidebarGroup label="Admin"  (role-gated)
│   │       └── SidebarMenu
│   │           ├── SidebarMenuItem → Users    (LuUserCog)    if canManageUsers
│   │           └── SidebarMenuItem → Audit    (LuShieldCheck) if canViewAudit
│   └── SidebarFooter
│       ├── SidebarSeparator
│       ├── UserMenu (avatar + name + role) (LuUserRound)
│       └── Sign out (LuLogOut)
└── SidebarInset  ← (replaces the current <main>)
    ├── Topbar (h-14, sticky) — breadcrumb + page title + per-page actions
    │   └── <OnlineRevalidationBar /> (moved from current <main>)
    └── Page content (children)
```

### 3.2 Mobile (<768px)

`SidebarProvider` auto-switches the `Sidebar` to a Sheet at ≤768px via its built-in `useMediaQuery('(max-width: 768px)')` branch — no custom mobile code needed.

```
Topbar (h-14, sticky)
├── SidebarTrigger (hamburger icon, LuMenu)  ← opens the Sheet sidebar
├── Page title (Heading, h-1 size sm)
└── Notification bell (LuBell) + UserMenu avatar (mobile-only compact)

[≡] Sheet slides from left, ~80% width:
  SidebarHeader (logo + name)
  SidebarContent (nav groups — same as desktop)
  SidebarFooter (sign out — no UserMenu, mobile users tap avatar in topbar)

Floating action button (only on /leads + /leads/[id], role-gated):
  bottom-right, h-14 w-14 rounded-full, primary color, LuPlus icon
  safe-area-inset-bottom already handled by layout.tsx
  hidden md+ (desktop uses top-right header button)
```

### 3.3 Page header pattern inside `SidebarInset`

```tsx
<div className="border-b px-4 py-3 sm:px-6 sm:py-4">
  <Breadcrumb items={[{label: 'Work'}, {label: pageTitle}]} />
  <div className="flex items-center justify-between gap-3">
    <Heading as="h1" size="xl">{pageTitle}</Heading>
    {pageAction /* e.g., "+ Add lead" */}
  </div>
</div>
```

---

## 4. Pass 2 — Interaction state coverage

| Feature | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| **Sidebar nav (mobile Sheet)** | Sheet open transition | n/a | n/a | n/a | n/a |
| **Sidebar nav active state** | n/a | n/a | n/a | bg-sidebar-accent ring | n/a |
| **UserMenu popover** | n/a | "Session expired" → /login | retry | name + role | n/a |
| **ChartCard: Pipeline funnel** | `ModulePending` "Loading funnel…" | "No leads this week. Add a lead to start your funnel." + CTA | retry | real bars | "Showing 3 of 12" |
| **ChartCard: Visits/week (bar)** | skeleton | "No visits scheduled this week." | retry | real bars | "Past 7 days" |
| **ChartCard: Lead status (pie)** | skeleton | "No leads yet — start by adding one." | retry | real pie | n/a |
| **ChartCard: Audit timeline** | skeleton | "No recent activity." | retry | real timeline | n/a |
| **Brand logo** | n/a | n/a | fallback text "Shadhil CRM" | logo image | n/a |
| **Floating action button** | n/a | n/a | hidden if offline | visible on /leads only | n/a |

**ModulePending is reused for every chart card** — same component, same contract. Charts never invent fake data.

---

## 5. Pass 3 — User journey & emotional arc

### 5.1 Telecaller named Asha (literal end-user)

| Step | She does | She feels | Plan supports it |
|---|---|---|---|
| 1 | Opens app on phone 9am | "What first?" | Hamburger → "Your queue" highlighted → tap → leads visible |
| 2 | Sees "Ravi · 47m overdue" | "Call NOW" | Overdue-first sort (locked Decision 0.2); phone + tap-to-call visible |
| 3 | Taps "Log outcome" after call | "Booked visit? Reached?" | Friendly labels: "Talked / Couldn't reach / Postponed / Booked visit" |
| 4 | Drives to site | "Address?" | "Open in Maps" deep-link on lead |
| 5 | Manager: weekly review | "Team on track?" | Role-tuned chart set with honest ModulePending |

### 5.2 Manager named Bala

Opens app on laptop Mon 9am. Sees admin-style Dashboard with chart cards: Pipeline funnel (org-wide), Visits-this-week (team bar), Lead status mix (pie). Below the charts: Overdue leads list (NEW >30 min, role-gated to assign). Top-right: "+ Add lead" button.

### 5.3 Admin named Deepa

Opens app. Sidebar shows "Admin" group with Users + Audit. Dashboard adds an extra chart row: Cross-team lead counts (bar by team) + Audit timeline (sparkline). Drilldowns link to /users and /audit.

---

## 6. Pass 4 — AI Slop Risk (defense)

- ❌ No 3-column feature grid. KPI strip is 4-col numbers, locked.
- ❌ No cards in chart layouts. Each chart is `ChartCard` (border + padding, NO shadow, NO rounded-lg).
- ❌ No emoji. Icons are Lucide via `@paalstack/react-icons/lu`.
- ❌ No purple/blue gradient backgrounds. Sidebar uses library default tokens; verify `--sidebar` and `--sidebar-accent` on first render and override only if they conflict with brand orange (Shadhil brand per logo commit).
- ❌ No rainbow palette. Charts use `--color-primary` dominant + `--color-muted` for baseline.
- ❌ No centered everything. Page titles left-aligned; KPI labels uppercase tracked.
- ❌ No decorative blobs / wavy SVG dividers.
- ✅ Each section has one job.
- ✅ Logo + brand text in SidebarHeader — brand unmistakable.

**Subtraction defaults applied:**
- `SectionCard` (bordered div) is replaced by thinner borders OR `<Paper elevation={0}>` from layouts — no shadow chrome.
- KPI strip stays as-is (locked).
- Charts: 1 per row on mobile, 2 per row on desktop (`md:grid-cols-2`); 3 only if Admin explicitly justifies.

---

## 7. Pass 5 — Design system alignment

### 7.1 Tokens (no overrides unless measured first)

- `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring` — light + dark in `base.css` of `@paalstack/react-ui`. Verify on first render; only override if brand orange is missing.
- Chart colors via `ChartConfig`: `{ leads: { color: 'var(--color-primary)' }, baseline: { color: 'var(--color-muted-foreground)' } }` — theme-aware.
- Spacing: sidebar groups `space-y-2`; page sections `space-y-6/8`; KPI strip `gap-x-6 gap-y-4` (existing).
- Typography: `Heading` / `TypographyP` from library, not raw `<h1>` / `<p>`.

### 7.2 New shared components

- **`apps/web/src/components/shared/ChartCard.tsx`** — wrapper around `Chart` + `ModulePending`-aware fallback. Props API: `<ChartCard title="…" description="…" query={…}>{(data) => <BarChart …/>}</ChartCard>`. Renders loading skeleton / empty / error / success states identically to `ModulePending`. Saves the engineer from re-implementing the state machine per chart.
- **`apps/web/src/components/shared/FloatingActionButton.tsx`** — role-gated, mobile-only, fixed bottom-right with safe-area-inset. Props: `<FloatingActionButton href="/leads/new" icon={<LuPlus />}>Add lead</FloatingActionButton>`.

### 7.3 Component placement summary

| Component | Source | Used for |
|---|---|---|
| `SidebarProvider` | `@paalstack/react-ui` | Wrap entire `(app)` route group |
| `Sidebar`, `SidebarInset` | `@paalstack/react-ui` | Shell |
| `SidebarHeader/Content/Footer/Group/Menu/MenuItem/MenuButton/MenuBadge/Separator` | `@paalstack/react-ui` | Nav structure |
| `SidebarTrigger` | `@paalstack/react-ui` | Hamburger on mobile topbar |
| `SidebarRail` | `@paalstack/react-ui` | Desktop collapse-to-icon rail (auto on hover-out) |
| `Chart` + `BarChart` / `LineChart` / `AreaChart` / `PieChart` | `@paalstack/react-ui` | Charts on Dashboard |
| `Breadcrumb`, `Empty`, `Error`, `Tooltip`, `Badge`, `Avatar` | `@paalstack/react-ui` | Page header + utility |
| `LuLayoutDashboard`, `LuUsers`, `LuCalendarDays`, `LuPackage`, `LuBell`, `LuShieldCheck`, `LuUserCog`, `LuUserRound`, `LuLogOut`, `LuMenu`, `LuPlus` | `@paalstack/react-icons/lu` | Icon set |

---

## 8. Pass 6 — Responsive & accessibility

### 8.1 Responsive specs

- **Breakpoint:** 768px (md). Below = mobile Sheet (auto), above = desktop persistent sidebar.
- **Sidebar collapse:** `collapsible="icon"` on desktop → 3rem icon-rail on mouse-out, expands on mouse-over or Ctrl/Cmd+B.
- **KPI strip:** already `grid-cols-2 sm:grid-cols-4`. Keep.
- **Charts:** 1 per row mobile, 2 per row desktop (`md:grid-cols-2`), 3 only for Admin Dashboard.
- **Touch targets:** 44px min via `min-h-11` everywhere.
- **Safe area:** layout.tsx already has `pb-[max(1.5rem,env(safe-area-inset-bottom))]`. Keep.
- **Floating action button:** `safe-area-inset-bottom` already handled; visible mobile-only (`md:hidden`).
- **Notification bell:** topbar right side, mobile thumb-reach.

### 8.2 Accessibility

- Sidebar ARIA landmarks built in (SidebarProvider handles `role="navigation"` on the wrapper).
- `SidebarTrigger` has built-in `aria-label="Toggle Sidebar"`.
- `SidebarMenuButton` accepts `aria-current` for active state.
- Charts: every chart MUST have an `aria-label` (e.g., "Pipeline funnel: 120 new leads, 48 contacted, 12 visited, 4 booked"). Implemented via `ChartCard` rendering `<h3 className="sr-only">{label}</h3>` for the chart description.
- Focus rings: rely on `--sidebar-ring` token. No custom focus styles.
- Color contrast: library theme ensures 4.5:1 on body text. Don't override.
- Keyboard: Ctrl/Cmd+B toggles sidebar (built into `SidebarProvider`).
- Screen reader: navigation landmark auto-generated.

### 8.3 Non-negotiables

- No raw enums in user-facing copy (see §9.1 friendly labels).
- No fake data on charts (ModulePending until module ships).
- No chart without aria-label.
- No layout decision without mobile + desktop spec.
- No icon without tooltip when collapsed (`SidebarMenuButton` ships `tooltip` prop).

---

## 9. Pass 7 — Unresolved design decisions (resolved)

| Decision | Resolution |
|---|---|
| Brand logo placement | **SidebarHeader only** (desktop always visible); topbar mobile shows hamburger only, sheet opens with logo |
| Bottom-nav vs hamburger mobile | **Hamburger-only** (SidebarProvider auto-Sheet) |
| Outcome enum labels | **Friendly**: Talked / Couldn't reach / Postponed / Booked visit (server stores enum) |
| Chart colors | **Single accent + muted baseline** (`--color-primary` + `--color-muted-foreground`) |
| Floating "+ Add lead" | **Yes, role-gated** (telecaller/exec/manager+) on `/leads` + `/leads/[id]`, mobile-only |
| OnlineRevalidationBar | **Move into SidebarInset topbar** (was inside `<main>`) |
| Notification bell | **Topbar right** (mobile thumb-reach) |
| UserMenu | **SidebarFooter** (desktop) / compact avatar only in topbar (mobile) |
| PWA install prompt | **Keep current position** (verify no collision with FAB) |
| Sidebar collapse default | **Expanded desktop / hidden mobile Sheet** (default) |

### 9.1 Friendly label mapping (non-tech UI ↔ engineering enum)

| Engineering (server) | Friendly UI | Used in |
|---|---|---|
| `NEW` | New | Lead status badge |
| `CONTACTED` | Talked | Lead status badge, outcome log |
| `VISIT_REQUESTED` | Visit requested | Lead status badge |
| `VISIT_SCHEDULED` | Visit booked | Lead status badge |
| `VISITED` | Visited | Lead status badge |
| `NEGOTIATION` | Negotiating | Lead status badge |
| `BOOKING_INITIATED` | Booking in progress | Lead status badge |
| `WON` | Won 🎉 | Lead status badge |
| `LOST` | Lost | Lead status badge |
| `COLD` | Cold | Lead status badge |
| `NO_SHOW` | Didn't show up | Visit outcome |
| `RESCHEDULED` | Postponed | Visit outcome |
| `CANCELLED` | Cancelled | Visit outcome |
| `COMPLETED` | Done | Visit outcome |
| `AVAILABLE` | Available | Inventory |
| `HOLD` | On hold | Inventory |
| `TOKEN` | Token received | Inventory |
| `SOLD` | Sold | Inventory |

Server still stores the enum; UI maps via a small `lib/labels.ts` lookup. No emoji except 🎉 for `WON` (deliberate celebration signal).

---

## 10. Implementation plan (file-by-file, ~17 files)

### 10.1 Foundational shell (P1 — must ship together)

1. **`apps/web/src/app/(app)/layout.tsx`** — wrap in `SidebarProvider`, swap `<main>` for `SidebarInset`, move `OnlineRevalidationBar` into the new topbar slot.
2. **`apps/web/src/components/app-shell.tsx`** *(new)* — the actual `Sidebar` content (logo + nav groups + footer with UserMenu + sign out). Role-gated admin group via `canManageUsers` / `canViewAudit`.
3. **`apps/web/src/components/app-header.tsx`** — REPLACE the existing top-nav with a slim topbar inside `SidebarInset`: `SidebarTrigger` (mobile) + breadcrumb + page title + notification bell + UserMenu avatar.
4. **`apps/web/src/components/user-menu.tsx`** *(extract from app-header.tsx)* — same popover, takes user/name/role/onSignOut, mounted in `SidebarFooter`.
5. **`apps/web/src/components/topbar.tsx`** *(new)* — wraps breadcrumb + page title + per-page actions; receives `pageTitle` + `actions` props.
6. **`apps/web/src/components/shared/ChartCard.tsx`** *(new)* — wrapper described in §7.2.
7. **`apps/web/src/components/shared/FloatingActionButton.tsx`** *(new)* — described in §7.2.
8. **`apps/web/src/lib/labels.ts`** *(new)* — friendly-label lookup from §9.1.

### 10.2 Charts on Dashboard (P1 — must ship together)

9. **`apps/web/src/app/(app)/page.tsx`** — manager + admin homes get chart cards. Telecaller / Sales Exec get a single "Your queue" funnel chart + overdue list.
10. **`apps/web/src/components/charts/PipelineFunnelChart.tsx`** *(new)* — `BarChart` horizontal, 4 stages (New → Talked → Visit booked → Booked), driven by `useLeads({limit:500})` grouped client-side. `aria-label` template.
11. **`apps/web/src/components/charts/VisitsThisWeekChart.tsx`** *(new)* — `BarChart` vertical, 7-day window, `useVisits({from,to})`. Mon–Sun labels.
12. **`apps/web/src/components/charts/LeadStatusPieChart.tsx`** *(new)* — `PieChart`, status counts from `useLeads`.
13. **`apps/web/src/components/charts/AuditTimelineChart.tsx`** *(new)* — `LineChart` sparkline, `useAuditLog({limit:200})` bucketed by day. Admin/Owner only.

### 10.3 Per-page wiring (P2 — same PR, ~6 files)

14. **`apps/web/src/app/(app)/leads/page.tsx`** — pass `pageTitle="Lead Inbox"`, add FAB mount.
15. **`apps/web/src/app/(app)/visits/page.tsx`** — pageTitle + FAB (gated `canScheduleVisits`).
16. **`apps/web/src/app/(app)/inventory/page.tsx`** — pageTitle only.
17. **`apps/web/src/app/(app)/notifications/page.tsx`** — pageTitle + bell badge wiring.
18. **`apps/web/src/app/(app)/users/page.tsx`** — pageTitle (admin-class only).
19. **`apps/web/src/app/(app)/audit/page.tsx`** — pageTitle (admin-class only).

### 10.4 Polish (P2 — same PR)

20. **`apps/web/src/components/shared/LeadStatusBadge.tsx`** — replace enum rendering with `lib/labels.ts` lookup. Verify existing usage.
21. **`apps/web/src/app/(app)/leads/[id]/page.tsx`** — replace any outcome enum with friendly labels via `lib/labels.ts`.
22. **`apps/web/public/icons/icon-512.png`** + `maskable-512.png` — already aligned per `c1118a7`; no change.

### 10.5 NOT in scope

- Adding new modules (leads/visits/inventory/bookings/notifications/audit backend).
- Manual reassignment v1.1 (DESIGN.md §1).
- Audit UI v1.1.
- Booking approval workflow v1.1.
- PWA push payload changes.
- New colors / brand redesign (logo exists; no theme override unless measured need).

---

## 11. Implementation tasks (for /autoplan aggregation)

**Updated 2026-09-03 by `/plan-eng-review`:** scope reduced from 10 tasks to 15 tasks per D1 (collapse wrapper files) + D2 (one generic + 2 chart specifics) + new findings from Sections 1-4. New tasks T1, T3, T11-T15 added; chart components split per D2; `LeadStatusBadge` swap is now a separate P1 regression test (T11).

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — `lib/nav.ts` — Extract NAV_ITEMS + add `getVisibleNav(role)` + `getNavBadge(role)` so sidebar + topbar share one nav source
  - Surfaced by: Eng-review Section 2 [P1] — DRY violation: `NAV_ITEMS` already in `app-header.tsx:29-35`
  - Files: `apps/web/src/lib/nav.ts` (new)
  - Verify: `pnpm --filter @shadhil/web type-check`; sidebar renders same nav as old top-nav for every role
- [ ] **T2 (P1, human: ~30min / CC: ~10min)** — `lib/labels.ts` — Friendly label lookup for all enums in §9.1
  - Surfaced by: Pass 3 §5 + Pass 7 — non-tech label decision (D2)
  - Files: `apps/web/src/lib/labels.ts` (new)
  - Verify: every enum listed in §9.1 has an entry; `LeadStatusBadge` and visit-outcome buttons render friendly labels
- [ ] **T3 (P1, human: ~15min / CC: ~3min)** — `lib/auth-actions.ts` — Extract `useSignOut()` hook from `app-header.tsx:42-46`
  - Surfaced by: Eng-review Section 2 [P2] — `signOut` duplicated logic
  - Files: `apps/web/src/lib/auth-actions.ts` (new)
  - Verify: clicking "Sign out" in either sidebar footer OR topbar avatar clears session and redirects to /login
- [ ] **T4 (P1, human: ~1h / CC: ~15min)** — `ChartCard` — Thin glue around `ModulePending`; takes query + render prop; reuses ModulePending for loading/error/empty
  - Surfaced by: Pass 2 + Eng-review Section 1 [P1] + D1 answer: "glue only, not independent state machine"
  - Files: `apps/web/src/components/shared/ChartCard.tsx` (new)
  - Verify: chart shows ModulePending-style loading skeleton; on 404/501 shows "module not built yet"; on data renders chart; on other errors shows `Empty` with error message
- [ ] **T5 (P1, human: ~30min / CC: ~10min)** — `FloatingActionButton` — Role-gated FAB; `shouldShowFab(role, pathname)` pure function + safe-area positioning + `md:hidden`
  - Surfaced by: D4 — floating CTA decision
  - Files: `apps/web/src/components/shared/FloatingActionButton.tsx` (new), `apps/web/src/components/shared/floating-action-button.test.ts` (new)
  - Verify: FAB visible only on mobile (`md:hidden`), only on /leads routes, only for telecaller/exec/manager+ roles
- [ ] **T6 (P1, human: ~2h / CC: ~25min)** — `app-shell.tsx` — Sidebar content component: logo (next/image) + nav groups (uses lib/nav) + UserMenu popover (extracted from header) + role-gated admin group + Sign out
  - Surfaced by: Pass 1 §3.1 + Pass 7 + Eng-review Section 1 [P2] (next/image) + Section 2 (DRY)
  - Files: `apps/web/src/components/app-shell.tsx` (new)
  - Verify: manual click-through all role nav states; logo fallback "Shadhil CRM" text if PNG missing
- [ ] **T7 (P1, human: ~1h / CC: ~10min)** — `(app)/layout.tsx` — Wrap `SidebarProvider`; replace `<main>` with `SidebarInset`; inline topbar JSX (no separate `topbar.tsx` per D1); move `OnlineRevalidationBar`
  - Surfaced by: Pass 1 §3.1 — desktop layout restructure + D1 collapse `topbar.tsx`
  - Files: `apps/web/src/app/(app)/layout.tsx`
  - Verify: login flow renders shell; mobile viewport (<768px) shows hamburger; desktop (≥768px) shows persistent sidebar; `OnlineRevalidationBar` still mounts
- [ ] **T8 (P1, human: ~30min / CC: ~5min)** — `app-header.tsx` — Replace top-nav with slim topbar (`SidebarTrigger` + page title + `NotificationBell` + UserMenu avatar); keep `OfflineQueueBadge`; use `useSignOut()` from T3
  - Surfaced by: Pass 1 §3.2 + Pass 7 — mobile hamburger + bell relocation + Eng-review Section 1 [P2] (bell deferral)
  - Files: `apps/web/src/components/app-header.tsx`
  - Verify: hamburger opens Sheet on mobile; bell badge renders `useNotifications({unreadOnly:true}).data?.length ?? 0` (always 0 until module ships); UserMenu popover works
- [ ] **T9 (P1, human: ~2h / CC: ~30min)** — Charts on Dashboard — `PipelineFunnelChart` + `VisitsThisWeekChart` as 2 dedicated chart files; `LeadStatusPie` + `AuditTimeline` inlined as generic `ChartCard` usages in `(app)/page.tsx` (D2)
  - Surfaced by: D3 — role-tuned chart set + D2 collapse to 2 specifics
  - Files: `apps/web/src/components/charts/PipelineFunnelChart.tsx` (new), `VisitsThisWeekChart.tsx` (new), `funnel.test.ts` (new), `visits-week.test.ts` (new), `apps/web/src/app/(app)/page.tsx`
  - Verify: each chart has `aria-label`; renders ModulePending until backend module ships; Manager sees 3 charts, Telecaller sees 1 chart, Admin sees 4 charts
- [ ] **T10 (P2, human: ~30min / CC: ~5min)** — Per-page wiring — pageTitle + breadcrumb on all 6 (app) routes (excludes `page.tsx` — covered by T9)
  - Surfaced by: Pass 1 §3.3 — page header pattern
  - Files: `apps/web/src/app/(app)/leads/page.tsx`, `visits/page.tsx`, `inventory/page.tsx`, `notifications/page.tsx`, `users/page.tsx`, `audit/page.tsx`
  - Verify: every page renders pageTitle; breadcrumb shows "Work → <page>"
- [ ] **T11 (P2, human: ~30min / CC: ~5min)** — Friendly labels adoption — `LeadStatusBadge` + visit outcome buttons render via `lib/labels.ts` (replaces `status.replace(/_/g, ' ')` at `LeadStatusBadge.tsx:34`)
  - Surfaced by: Eng-review Section 2 [P1] — `LeadStatusBadge` is the canonical wire-up site for status labels
  - Files: `apps/web/src/components/shared/LeadStatusBadge.tsx`, `apps/web/src/app/(app)/leads/[id]/page.tsx`, `apps/web/src/app/(app)/visits/page.tsx`
  - Verify: visit outcome buttons render "Talked / Couldn't reach / Postponed / Booked visit"; lead status badge shows friendly names; regression test ensures no raw enum leaks
- [ ] **T12 (P3, follow-up)** — Sidebar color tokens — Render sidebar in dev; if orange/amber is missing, override `--sidebar` tokens in `globals.css`
  - Surfaced by: Pass 4 — brand unmistakable check + Eng-review Section 1 [P2]
  - Files: `apps/web/src/app/globals.css` (conditional)
  - Verify: rendered sidebar shows Shadhil brand color; not purple/blue default
- [ ] **T13 (P2, human: ~30min / CC: ~5min)** — ASCII diagram comments — Add to: `app-shell.tsx` (nav state + role-gating); `layout.tsx` (SSR vs client-only); `lib/labels.ts` (enum→label with link to Prisma); `lib/nav.ts` (nav tree + role-gating); `ChartCard.tsx` (query state → render)
  - Surfaced by: Eng-review Section 2 [P2] — diagram maintenance hook
  - Files: `apps/web/src/components/app-shell.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/lib/labels.ts`, `apps/web/src/lib/nav.ts`, `apps/web/src/components/shared/ChartCard.tsx`
  - Verify: each diagram is byte-accurate with the code it documents
- [ ] **T14 (P2, human: ~10min / CC: ~2min)** — Decision Audit Trail entry — Append to `IMPLEMENTATION-PLAN-v1.md` capturing the 2026-09-03 app-shell redesign
  - Surfaced by: AGENTS.md (planning documents rule) + Eng-review Section 2 TODOS
  - Files: `docs/planning/IMPLEMENTATION-PLAN-v1.md`
  - Verify: new row in Decision Audit Trail table; date, decision, rationale, links all present
- [ ] **T15 (P1, human: ~20min / CC: ~5min)** — `nav.test.ts` — Tests for `getVisibleNav(role)` — Telecaller sees no Audit; Manager sees Users not Audit; Owner sees Users + Audit
  - Surfaced by: Eng-review Section 3 — test diagram gap; protects against role-gating regression
  - Files: `apps/web/src/lib/nav.test.ts` (new)
  - Verify: `pnpm --filter @shadhil/web test` green; 4 role assertions pass

### CEO Review additions (skeleton loading layer, T16-T27)

The user's follow-up ask: "add proper skeleton loading as well." All10 expansion proposals accepted; scope grew 15 → 27 tasks.

- [ ] **T16 (P1, human: ~30min / CC: ~10min)** — `Skeleton.tsx` — Single generic Skeleton component with variants (`kpi|chart|table|list|card|user`); uses library `Skeleton` + Tailwind `animate-pulse`; brand-aligned `bg-muted` (not pure gray)
  - Surfaced by: CEO Section 5 [P1] DRY collapse + Section 4 [P2] user/card variants
  - Files: `apps/web/src/components/shared/Skeleton.tsx` (new)
  - Verify: `aria-busy="true"` on container; contrast ≥3:1 on muted bg; motion-reduce respected
- [ ] **T17 (P1, human: ~30min / CC: ~10min)** — `SkeletonContainer.tsx` — Wraps skeleton + real content with cross-fade (`opacity-0/100 duration-200 motion-reduce:transition-none`)
  - Surfaced by: CEO cherry-pick D1 + Section 11 design review
  - Files: `apps/web/src/components/shared/SkeletonContainer.tsx` (new)
  - Verify: fade fires on `isLoading→loaded`; respects `prefers-reduced-motion`
- [ ] **T18 (P1, human: ~30min / CC: ~10min)** — `ModulePending.tsx` — Replace isLoading text "Loading…" with appropriate Skeleton variant (table/list); keep existing state machine
  - Surfaced by: CEO Section 1 [P1] skeleton state collision + D3 cherry-pick
  - Files: `apps/web/src/components/shared/ModulePending.tsx`
  - Verify: when `isLoading`, render Skeleton; when `error`, render Empty (regression)
- [ ] **T19 (P1, human: ~30min / CC: ~10min)** — `ChartCard.tsx` — `isLoading` renders Skeleton variant="chart" of matching kind (bar=5 bars, pie=circle, line=axes); cross-fade via SkeletonContainer
  - Surfaced by: CEO Section 1 [P1] + D1 + D3
  - Files: `apps/web/src/components/shared/ChartCard.tsx`
  - Verify: bar/pie/line each get shape-matched skeleton; data swap fades
- [ ] **T20 (P1, human: ~20min / CC: ~5min)** — KpiStrip shimmer — Value fades from "—" to real number with `shimmer-once` pulse; Skeleton variant="kpi" while `isLoading`
  - Surfaced by: CEO D2 cherry-pick + Section 1 [P2] KpiStrip inconsistency
  - Files: `apps/web/src/app/(app)/page.tsx`
  - Verify: visual test in browser; shimmer doesn't fire when `prefers-reduced-motion`
- [ ] **T21 (P1, human: ~30min / CC: ~5min)** — TanStack Query timeouts — Add 30s timeout to every `useQuery` call; prevents skeleton-pulse-forever; logs warning at 30s
  - Surfaced by: CEO Section 2 + 1A user-accepted finding
  - Files: `apps/web/src/lib/query-client/lib.ts`, `apps/web/src/hooks/queries/crm.ts`, `apps/web/src/hooks/queries/users.ts`
  - Verify: query past 30s logs warning + surfaces timeout error
- [ ] **T22 (P1, human: ~20min / CC: ~5min)** — `ErrorBoundary.tsx` — Add above ChartCard with skeleton-rescue fallback; prevents white-screen-on-render
  - Surfaced by: CEO Section 2 + 1B user-accepted finding
  - Files: `apps/web/src/components/shared/ErrorBoundary.tsx` (new), `apps/web/src/components/shared/ChartCard.tsx`
  - Verify: render throw inside ChartCard shows fallback, not white screen
- [ ] **T23 (P1, human: ~20min / CC: ~5min)** — UserSkeleton — Avatar + name + role placeholder in sidebar footer + topbar; rendered while `sessionPending`
  - Surfaced by: CEO Section 4 [P2] + 1C
  - Files: `apps/web/src/components/shared/Skeleton.tsx` (variant), `apps/web/src/components/app-shell.tsx`, `apps/web/src/components/app-header.tsx`
  - Verify: signed-out / signed-in transitions render UserSkeleton not text
- [ ] **T24 (P1, human: ~20min / CC: ~5min)** — `placeholderData: keepPreviousData` — Set on every chart query — skeleton only on first load, not on navigation
  - Surfaced by: CEO Section 1 [P2] stale-data flicker
  - Files: `apps/web/src/hooks/queries/crm.ts`
  - Verify: navigating away and back keeps old data visible during refetch
- [ ] **T25 (P1, human: ~30min / CC: ~10min)** — Offline-aware skeleton — Skeleton variant="list" surfaces offline state (paired with `offline-queue-badge`); when offline + pending, shows "Will sync when online" label
  - Surfaced by: CEO D4 cherry-pick
  - Files: `apps/web/src/components/shared/Skeleton.tsx`, `apps/web/src/components/offline-queue-badge.tsx`
  - Verify: offline + loading skeleton shows the sync label; badge appears in same view
- [ ] **T26 (P2, human: ~1h / CC: ~15min)** — `skeleton.test.ts` + `skeleton-container.test.ts` — Vitest: Skeleton variant contracts; aria-busy; contrast ≥3:1; motion-reduce; cross-fade fires on `isLoading→loaded`
  - Surfaced by: CEO Section 6 test diagram (12 gaps)
  - Files: `apps/web/src/components/shared/skeleton.test.ts` (new), `apps/web/src/components/shared/skeleton-container.test.ts` (new)
  - Verify: `pnpm --filter @shadhil/web test` green; 4 variants × 5 assertions = 20 test cases
- [ ] **T27 (P2, human: ~45min / CC: ~15min)** — Per-page wiring — Replace text Loading… in 7 sites: `/leads` (line 88), `/visits` (line 119), `/users` (line 88), `/notifications` (line 68), `/audit` (line 68), `/leads/[id]` (line 30), `(app)/page.tsx` (line 30); each renders matching Skeleton variant
  - Surfaced by: CEO Section 6 regression coverage
  - Files: 7 page files in `apps/web/src/app/(app)/`
  - Verify: no `Loading…` text remains in source (grep)

### CEO Re-Review additions (pre-implementation gate, T28-T35)

The user's gate: re-review all new changes in this session before implementation. Mode: SELECTIVE EXPANSION (existing plan posture). 8 hidden landmines surfaced; 1A-1G all accepted. Final plan: **35 tasks across 3 PRs**.

- [ ] **T28 (P1, human: ~15min / CC: ~3min)** — recharts SSR min-height — Add `min-h-[200px]` (or appropriate) to chart container; eliminates recharts `ResponsiveContainer` width=0 invisible-chart flash on hydration
  - Surfaced by: Re-review Section 1 [P1] recharts SSR width=0 + 1A user-accepted
  - Files: chart components + `(app)/page.tsx`
  - Verify: chart visible immediately on hydration in slow 3G throttling
- [ ] **T29 (P1, human: ~30min / CC: ~5min)** — `apis/client.ts` AbortSignal — Forward `AbortSignal` from TanStack Query to fetch; makes T21 timeout actually abort the request
  - Surfaced by: Re-review Section 1 [P1] TanStack Query timeout is UI-only without AbortController + 1B user-accepted
  - Files: `apps/web/src/apis/client.ts`
  - Verify: `pnpm dev` + manual abort triggers; check network panel shows aborted fetch
- [ ] **T30 (P1, human: ~15min / CC: ~3min)** — Sidebar defaultOpen=false on mobile — Suppress sidebar cookie SSR flash by detecting viewport in `(app)/layout.tsx` and passing `defaultOpen={false}` to `SidebarProvider` on mobile
  - Surfaced by: Re-review Section 1 [P2] sidebar cookie SSR flash + 1C user-accepted
  - Files: `apps/web/src/app/(app)/layout.tsx`
  - Verify: mobile viewport first paint shows Sheet trigger, not desktop sidebar
- [ ] **T31 (P1, human: ~5min / CC: ~2min)** — ErrorBoundary → Empty not Skeleton — Refine T22 fallback to render `Empty` with clear error message, not skeleton (skeleton hides the failure)
  - Surfaced by: Re-review Section 5 [P2] premature abstraction + 1D user-accepted
  - Files: `apps/web/src/components/shared/ChartCard.tsx`
  - Verify: throw inside ChartCard renders Empty, not infinite skeleton
- [ ] **T32 (P1, human: ~30min / CC: ~10min)** — Skeleton shape-count tests — Each variant test asserts specific shape (5 table rows, 4 KPI blocks, 5 bar bars, 1 pie circle) not just `toBeTruthy()`
  - Surfaced by: Re-review Section 6 [P1] tests-that-don't-test + 1E user-accepted
  - Files: `apps/web/src/components/shared/skeleton.test.ts`
  - Verify: `pnpm --filter @shadhil/web test` green; 6 variants × shape assertions
- [ ] **T33 (P1, human: ~15min / CC: ~5min)** — Cross-fade computed-style assertion — Test asserts `getComputedStyle(el).transitionDuration === '200ms'` instead of `vi.useFakeTimers()` (CSS animations not paused by fake timers)
  - Surfaced by: Re-review Section 6 [P1] fragile timer-based test + 1F user-accepted
  - Files: `apps/web/src/components/shared/skeleton-container.test.ts`
  - Verify: regression of transitionDuration → 800ms triggers test failure
- [ ] **T34 (P2, human: ~15min / CC: ~5min)** — Skeleton dataHint — Skeleton variant="chart" accepts `dataHint` prop (bar=5-bars, pie=circle, line=zigzag, area=3-humps) so skeleton shape matches real data shape on empty/initial
  - Surfaced by: Re-review Section 4 [P2] empty data shape mismatch
  - Files: `apps/web/src/components/shared/Skeleton.tsx`
  - Verify: empty chart data + skeleton = visually consistent shape
- [ ] **T35 (P2, human: ~5min / CC: ~1min)** — PR split strategy — Document the 3-PR split in this plan: PR1 = T1-T15 (shell); PR2 = T16+T17+T18+T19+T26+T27 (skeletons + per-page wiring); PR3 = T20+T21+T22+T23+T24+T25+T28-T33 (polish + safety)
  - Surfaced by: Re-review Section 9 PR split + 1G user-accepted
  - Files: this plan file (§11 task ordering)
  - Verify: each PR's tasks are sequential with no cross-PR dependencies

### Bring-back-in (NOT in scope → in scope, T36-T38)

User explicitly asked to bring back the 3 previously-deferred items. P2 polish each; fit PR3 (single-line shipping).

- [ ] **T36 (P2, human: ~5min / CC: ~2min)** — `loading.tsx` for /login — Add Next.js per-route `loading.tsx` for `/login`; renders `<Loading variant="spinner" label="Signing in…" />` via `@paalstack/react-ui` so the login page never shows a blank wall during the auth round-trip
  - Surfaced by: Re-review NOT-in-scope bring-back-in: D1 user-picked (login default loading)
  - Files: `apps/web/src/app/login/loading.tsx` (new)
  - Verify: hard-reload `/login` shows spinner immediately; replaced by real form when JS hydrates
- [ ] **T37 (P2, human: ~20min / CC: ~5min)** — Sidebar nav active-state sync — Wrap `SidebarProvider`'s mobile Sheet in a small `useNavSync` hook that closes the Sheet when `usePathname()` changes; encapsulates the library-drift risk so library updates don't reintroduce the bug
  - Surfaced by: Re-review NOT-in-scope bring-back-in: D1 user-picked (sidebar nav itself)
  - Files: `apps/web/src/components/app-shell.tsx`, `apps/web/src/lib/nav.ts`
  - Verify: tap a nav item on mobile → Sheet closes within 200ms; route changes; on desktop no behavior change
- [ ] **T38 (P2, human: ~15min / CC: ~5min)** — Chart tooltip skeleton — Recharts `customTooltip` prop renders `<Skeleton variant="card" rows={2} />` while `ChartCard.isLoading`; on hover with data, renders real tooltip; bridges the gap between chart-shape skeleton and live data
  - Surfaced by: Re-review NOT-in-scope bring-back-in: D1 user-picked (chart tooltip)
  - Files: `apps/web/src/components/shared/ChartCard.tsx`, `apps/web/src/components/shared/Skeleton.tsx`
  - Verify: hover over chart during isLoading shows tooltip-shaped skeleton; on data hover shows real values

---

## 12. Review Readiness Dashboard

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | SELECTIVE EXPANSION; 10/10 proposals accepted; scope 10→27 tasks; lake score 10/10 |
| CEO Review (re) | `/plan-ceo-review` | Pre-impl gate (re-review all session changes) | 1 | clean | 8 hidden landmines (recharts SSR, AbortSignal, sidebar flash, ErrorBoundary scope, test shape-count, computed-style assertion, dataHint, PR split); 27→35 tasks; 3-PR split locked |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 8 issues (2 P1 DRY, 1 P1 SSR, 2 P2 image/cookie, 1 P2 bell deferral, 1 P2 dedup, 1 P2 cookies), 24 test gaps, 2 critical failure-mode gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score 3/10 → 8/10, 9 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** design + eng + CEO + CEO-reviews complete — ready for `pn dev` walkthrough then implementation in 3 PRs (T1-T15 → T16-T27 → T20-T35). All findings folded into §11 tasks.

**Unresolved-decisions status:** NO UNRESOLVED DECISIONS

---

## 13. Eng Review Findings (2026-09-03, /plan-eng-review)

Full findings are baked into §11 task list. Summary:

- **Step 0:** Scope reduced (D1: collapse wrapper files; D2: 1 generic + 2 chart specifics). New-file count: 5 → 3 wrapper files. Chart files: 4 → 2.
- **Section 1 (Architecture):** 4 findings. 1 P1 (ChartCard must be glue around ModulePending, not independent state machine) — addressed in T4. 1 P1 (lib/labels.ts needs enum-source-of-truth assertion) — addressed in T2. 1 P1 (SidebarProvider is 'use client' → no SSR shell — documented as deliberate). 2 P2 (next/image for logo + notification bell deferral resolution) — addressed in T6 + T8.
- **Section 2 (Code Quality):** 4 findings. 2 P1 (DRY: NAV_ITEMS + LeadStatusBadge canonical wire-up site) — addressed in T1 + T11. 2 P2 (signOut extract + diagram maintenance) — addressed in T3 + T13.
- **Section 3 (Tests):** 24 gaps. Plan adds `lib/nav.test.ts` (T15), `lib/labels.test.ts` (T2), `funnel.test.ts` + `visits-week.test.ts` (T9), `floating-action-button.test.ts` (T5). Regression tests for `LeadStatusBadge` and relocated components in T11 + T7.
- **Section 4 (Performance):** 2 findings (P2 each). staleTime verification for `useAuditLog` + recharts bundle size — both verify-in-prod, no action.
- **Critical gaps:** 2 (FAB silent-offline; logo 404 fallback unverified) — addressed by T5 shouldShowFab guard + T6 fallback text.
- **Parallelization:** 6 lanes (A: labels+nav, B: FAB, C: ChartCard, D: app-shell, E: layout+header+page wiring, F: charts+regression, G: brand verify). Sequential dependencies documented in JSONL.
- **Lake Score:** 5/5 architectural recommendations chose complete over shortcut (no shortcuts taken).

**Test framework:** Vitest, pure-function tests only (no `@testing-library/react` per `shadhil-crm-dev` skill).

---

## 14. CEO Review Findings (2026-09-03, /plan-ceo-review)

Mode: **SELECTIVE EXPANSION** (user's verbatim: "add proper skeleton loading as well" → feature enhancement on existing system). Vision: shape-matched skeletons that cross-fade to real content over 200ms; non-technical user never sees "Loading…" text. CEO plan persisted to `~/.gstack/projects/shadhilbuilders-crm/ceo-plans/2026-09-03-crm-app-shell-redesign.md`.

### Scope decisions (SELECTIVE EXPANSION cherry-picks)

| Proposal | Decision | Reasoning |
|---|---|---|
| Skeleton-to-real cross-fade (200ms) | ACCEPTED | The "alive UI" feel vs skeletons popping out |
| KPI strip shimmer-once pulse | ACCEPTED | Same delight story; differentiates data arrival |
| Skeleton vs ModulePending single source of truth | ACCEPTED | Kill the text "Loading…" everywhere |
| Offline-aware skeletons (pair with offline-queue) | ACCEPTED | User chose all-in |
| 4 dedicated skeleton files | REJECTED → 1 generic with variants | DRY collapse (1D) |
| Session-loading uses UserSkeleton | ACCEPTED | 1C |
| TanStack Query explicit timeouts | ACCEPTED | 1A — prevents skeleton-pulse-forever |
| React error boundary above ChartCard | ACCEPTED | 1B — prevents white-screen-on-render |
| Approach C (RSC streaming + prefetch) | DEFERRED to TODOS.md | 10x ideal, but separate architecture conversation |

**All 10 expansion proposals accepted (4 cherry-picks + 6 findings from CEO review sections).** Scope grew from 15 → 27 tasks.

### Section findings (focused — 11 sections, no exhaustive re-derivation since this is the 3rd skill review on the same plan)

- **Section 1 (Architecture):** 3 findings. P1 [9/10] skeleton state machine collides with ModulePending's text Loading — T18 fixes. P2 [8/10] KpiStrip "—" inconsistent with chart skeletons — T20 fixes. P2 [7/10] `placeholderData: keepPreviousData` reduces skeleton flash — T24.
- **Section 2 (Errors):** 5 failure modes. 3 critical gaps accepted: skeleton-pulse-forever (1A → T21), white-screen-on-render (1B → T22), session-loading wrong skeleton (1C → T23).
- **Section 3 (Security):** No issues found — skeletons are inert DOM.
- **Section 4 (Data/UX):** 5 edge cases. Session-loading flagged (T23). Colorblind contrast ≥3:1 enforced in T26 tests.
- **Section 5 (Code Quality):** 3 findings. P1 [9/10] DRY: 4 skeleton files → 1 generic with variants (1D → T16). P2 [7/10] fade transition = CSS class only, no hook. P2 [6/10] KpiStrip shimmer + motion-reduce verified in T26.
- **Section 6 (Tests):** 12 gaps. T26 (skeleton tests) covers variant contracts, aria-busy, contrast, motion-reduce. Regression tests for ModulePending and ChartCard text→skeleton swap.
- **Section 7 (Performance):** 3 P2 findings, all marginal/no-action. `placeholderData: keepPreviousData` is the only one with action (T24).
- **Section 8 (Observability):** 1 P2 — `time_to_first_real_content` metric deferred to TODOS.md.
- **Section 9 (Deployment):** No risks. Skeleton layer is pure CSS + query config. No DB migration.
- **Section 10 (Future):** Reversibility 4/5. Foundation laid for Approach C (RSC streaming + prefetch). No one-way doors.
- **Section 11 (Design):** All4 interaction states covered. AI slop risk mitigated by brand-aligned muted color (not pure gray). Accessibility: aria-busy="true", motion-reduce respected.

### Failure modes (final)

| Codepath | Failure | Rescued | Test | User sees |
|---|---|---|---|---|
| ChartCard isLoading | query times out (30s) | Y (T21) | GAP → T26 | skeleton → error Empty |
| ChartCard render | render throws | Y (T22) | GAP → T26 | error boundary fallback |
| TableSkeleton → real | query errors | Y (ModulePending) | GAP → T26 | skeleton → "no data" |
| Cross-fade | motion-reduce not respected | Y (CSS) | GAP → T26 | instant swap |
| Session-loading | hook never resolves | Y (T21 timeout) | GAP → T26 | skeleton forever → "session timed out" |

**Critical gaps after T16-T27:** 0

### TODOS.md updates (deferred from CEO review)

| What | Effort | Priority |
|---|---|---|
| `time_to_first_real_content` metric via `/api/metrics/ttfr` | M | P3 |
| Approach C (RSC skeletons + TanStack prefetch on link hover) | XL | P3 |
| `Loading` component audit (login, modals — replace spinners with `<Loading>`) | S | P3 |

### What already exists (reused)

- `Skeleton` + `SkeletonContainer` from `@paalstack/react-ui` (unused, now wired up)
- `Loading` (variant=spinner|dots) for page-level fallback
- `ModulePending` state machine (extended, not replaced)
- `tailwindcss-animate` + `shimmer-once` utility from `@paalstack/react-ui/utilities.css`
- TanStack Query `placeholderData: keepPreviousData` API

### Final task list summary

**P1 tasks:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25 = **20 P1**
**P2 tasks:** T10, T11, T13, T14, T26, T27 = **6 P2**
**P3 tasks:** T12 = **1 P3**

**Total:** 27 tasks (vs original 10 → +170% scope, all justified by user-accepted cherry-picks + CEO findings)

**Lake Score:** 10/10 architectural recommendations chose complete over shortcut.

---

## 15. CEO Re-Review Findings (2026-09-03, /plan-ceo-review — pre-implementation gate)

**Trigger:** User asked "i want do the ceo-review for all the new changes in this session before implementation" — this is a pre-implementation gate review over the cumulative plan (design + eng + CEO + skeleton layers). Mode: SELECTIVE EXPANSION (existing plan posture, no fresh scope expansion). Result: **8 hidden landmines surfaced** that the original passes missed.

### Section findings (focused re-review)

- **Section 1 (Architecture):** 3 new findings. P1 [9/10] recharts SSR width=0 → invisible chart flash — T28. P1 [9/10] TanStack Query timeout is UI-only without AbortController — T29. P2 [7/10] sidebar cookie SSR flash on mobile — T30.
- **Section 2 (Errors):** No new findings — error map unchanged from first pass.
- **Section 3 (Security):** No new findings — skeletons are inert DOM, labels are dev-controlled string literals.
- **Section 4 (Data/UX):** 1 new finding. P2 [7/10] skeleton variant="chart" shape mismatch on empty data — T34.
- **Section 5 (Code Quality):** 1 new finding. P2 [7/10] ErrorBoundary premature abstraction (fallback should be Empty not skeleton) — T31.
- **Section 6 (Tests):** 2 new findings. P1 [9/10] tests-that-don't-test (shape-count assertions) — T32. P1 [8/10] fragile timer-based test (use computed style) — T33.
- **Section 7 (Performance):** No new findings.
- **Section 8 (Observability):** No new findings.
- **Section 9 (Deployment):** PR split strategy — T35 documents the 3-PR split.
- **Section 10 (Future):** Reversibility confirmed 5/5; no new findings.
- **Section 11 (Design):** Motion overload concern flagged — admin dashboard has 4 charts + cross-fade + shimmer; verify `prefers-reduced-motion` visually, not just in tests. Locked in T26.

### 3-PR split (locked)

```
PR1 (Shell): T1-T15
  Sidebar shell + labels + signOut + nav.test
  Reversible: yes (CSS swap; no schema changes)

PR2 (Skeletons): T16+T17+T18+T19+T26+T27
  Skeleton primitives + ChartCard + ModulePending + tests + per-page wiring
  Reversible: yes (component swap)

PR3 (Polish + Safety): T20+T21+T22+T23+T24+T25+T28-T33
  Shimmer + timeouts + error boundary + UserSkeleton + keepPreviousData +
  offline-aware + recharts SSR min-height + AbortSignal + sidebar defaultOpen +
  ErrorBoundary scope + skeleton shape tests + cross-fade computed-style test
  Reversible: yes (each task independent)
```

### Final task list (35 tasks)

- **PR1 (T1-T15):** 15 tasks (12 P1, 3 P2) — app shell + labels + signOut
- **PR2 (T16-T19, T26-T27):** 7 tasks (6 P1, 1 P2) — skeleton layer
- **PR3 (T20-T25, T28-T34):** 13 tasks (11 P1, 2 P2) — polish + safety

**Total: 35 tasks (P1: 29, P2: 6, P3: 0)** — vs original 10 → +250% scope, all justified by user-accepted cherry-picks + re-review findings.

**Lake Score:** 8/8 re-review recommendations chose complete over shortcut.

**Critical gaps after T28-T35:** 0

### Re-review findings vs original CEO findings — what changed

| Finding | Original CEO | Re-review |
|---|---|---|
| Chart loading state | ModulePending text | Skeleton variant |
| Cross-fade | D1 cherry-pick | T17 + computed-style test (T33) |
| Timeouts | T21 query-side | + T29 abort-side (NEW) |
| Error boundary | T22 skeleton fallback | T31 Empty fallback (NEW scope) |
| Tests | T26 smoke | T32 shape-count (NEW) |
| SSR safety | not addressed | T28 recharts min-height (NEW) |
| Sidebar mobile | not addressed | T30 defaultOpen=false (NEW) |
| PR sequencing | "split into 3 PRs" suggested | T35 documents explicit split |

---

## Appendix A — Existing files referenced

- `apps/web/src/app/(app)/layout.tsx` (21 lines) — current shell
- `apps/web/src/components/app-header.tsx` (168 lines) — current top-nav
- `apps/web/src/app/(app)/page.tsx` (248 lines) — current role-aware Dashboard
- `apps/web/src/components/shared/ModulePending.tsx` — honest-state pattern (reuse for charts)
- `apps/web/src/components/shared/LeadStatusBadge.tsx` — needs friendly-label swap
- `apps/web/src/lib/session.ts` (107 lines) — role helpers (no change needed)
- `apps/web/src/hooks/queries/crm.ts` (158 lines) — useLeads/useVisits/useBookings/useNotifications/useAuditLog (reuse for charts)
- `apps/web/public/brand/logo.png` — exists per commit `c1118a7`
- `docs/planning/DESIGN.md` — single source of truth for role/permission/label decisions

## Appendix B — Library API quick reference

```tsx
import {
  Sidebar, SidebarProvider, SidebarInset,
  SidebarHeader, SidebarContent, SidebarFooter,
  SidebarGroup, SidebarGroupLabel, SidebarSeparator,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuBadge,
  SidebarTrigger, SidebarRail,
  Chart, BarChart, LineChart, AreaChart, PieChart,
  Breadcrumb, Empty, Error, Tooltip, Badge, Avatar, Button,
} from '@paalstack/react-ui';
import {
  LuLayoutDashboard, LuUsers, LuCalendarDays, LuPackage, LuBell,
  LuShieldCheck, LuUserCog, LuUserRound, LuLogOut, LuMenu, LuPlus,
} from '@paalstack/react-icons/lu';
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | SELECTIVE EXPANSION; 10/10 accepted; scope 10→27 tasks; lake 10/10 |
| CEO Review (re) | `/plan-ceo-review` | Pre-impl gate | 1 | clean | 8 landmines (T28-T35); 27→35 tasks; 3-PR split |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 8 issues, 24 test gaps, 2 critical failure-mode gaps, 6 parallel lanes |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score 3/10 → 8/10, 9 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** design + eng + CEO + CEO-reviews complete — ready for `pn dev` walkthrough then implementation in 3 PRs (T1-T15 → T16-T27 → T20-T35). No outstanding reviews.

NO UNRESOLVED DECISIONS