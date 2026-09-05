# Shadhil CRM - ASCII Wireframes (locked UI design)

**Source:** `IMPLEMENTATION-PLAN-v1.md` + `/plan-design-review` + `/plan-eng-review` decisions.
**Component library:** `@paalstack/react-ui` (consume, don't author).
**Brand tokens:** `#001a4c` (primary) · `#62b132` (secondary) · `#f8f5ef` (surface) · `#dc2626` (no-show) · `#f59e0b` (rescheduled) · `#16a34a` (visited).
**Typography:** IBM Plex Sans. NOT Inter, NOT Geist.
**Icon library:** `lucide-react` via `@paalstack/react-icons/lu`. No colored circles around icons.
**Negative spec:** No purple gradients, no card mosaic, no decorative blobs, no charts (numbers + trend only), no stock photos, no uniform bubbly radius, no `border-left: 3px solid` accents.

---

## 1. Manager Dashboard - web (1280px+)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  [Shadhil Metro Heights · CRM]                  🔔3   Rajesh K. (Manager) ▼  │ top nav
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  Dashboard                                                  [Date: Aug 30, 2026 ▼] │
│                                                                                    │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐                     │
│  │ Time-to-     │ Today's      │ Bookings     │ Yesterday's  │                     │
│  │ first-touch  │ scheduled    │ awaiting     │ no-show      │   <- KPI strip     │
│  │              │ visits       │ approval     │ rate         │     (4 numbers,    │
│  │   18 min     │   12         │   3          │   22%       │     1 row, no      │
│  │              │              │              │              │     cards)         │
│  │ ────│       │ 4 execs      │ oldest: 2h   │ ↓ vs 28%     │                     │
│  │ target: <30  │              │              │ (improving)  │                     │
│  └──────────────┴──────────────┴──────────────┴──────────────┘                     │
│                                                                                    │
│                                                                                    │
│  Team pipeline - Sales Team A (6 agents)                            [Filter ▼]     │
│  ───────────────────────────────────────────────────────────────────────────────  │
│                                                                                    │
│  Visits today (5)                                                  [See all →]    │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ 09:30  Vikram E.   Rajesh K.       Mudichur Phase 1  →  VISITED   ✓     │    │
│  │ 11:00  Anjali P.  Priya M.       Mudichur Phase 2  →  pending         │    │
│  │ 14:00  Vikram E.   Suresh R.       Mudichur Phase 1  →  VISITED   ✓     │    │
│  │ 15:30  Anjali P.  Lakshmi N.     Mudichur Phase 2  →  NO_SHOW   ⚠     │    │
│  │ 16:30  Vikram E.   Murali K.       Mudichur Phase 1  →  pending         │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
│  Bookings in progress (2)                                            [See all →]  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ Unit A-204  Rajesh K.   Vikram E.   Token receipt: pending  [Review →]  │    │
│  │ Unit B-112  Priya M.    Anjali P.   Token receipt: received [Approve]  │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
│  Overdue leads - first-touch > 30 min (3)                            [See all →]  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ ⚠ 12 min overdue  Suresh R.    NEW → CONTACTED    Asha T.  [Reassign]   │    │
│  │ ⚠  8 min overdue  Lakshmi N.  NEW                  Asha T.  [Reassign]   │    │
│  │ ⚠  6 min overdue  Murali K.    NEW                  Vikram E.  [Reassign]   │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- KPI strip = 4 numbers in a single row, **not** a card grid. `Box` with `gap-4`, each KPI is a `Stack` with number + label + thin progress line + trend arrow.
- Team pipeline = `DataTable` from `@paalstack/react-ui`. Three sections on the same page, each with "See all →" deep link.
- Status badges use semantic colors: green for VISITED, red for NO_SHOW, amber for pending.
- Manager-only actions: `Reassign` button on every row. Hidden for Telecaller/Sales Exec (per §18 permission model).
- "Overdue leads" section is the manager's primary action surface - they click "Reassign" here when a Telecaller isn't responding.

---

## 2. Manager Dashboard - mobile (375px)

```
┌─────────────────────────┐
│ Dashboard     🔔3   ⋯  │   <- top bar
├─────────────────────────┤
│                         │
│  ← swipe to navigate → │
│                         │
│  ┌───────────────────┐  │
│  │                   │  │   <- swipeable KPI card
│  │ Time-to-          │  │     (one per screen, swipe gesture)
│  │ first-touch       │  │     Reanimated v4 transform/opacity
│  │   today           │  │
│  │                   │  │
│  │   18 min          │  │
│  │                   │  │
│  │ target: < 30 min  │  │
│  │ ●━━━━━━━━━━━━━━━ │  │
│  └───────────────────┘  │
│                         │
│  Visits today (5)        │
│  ────────────────        │
│  09:30  Vikram E.  ✓      │
│         Rajesh K.        │
│  11:00  Anjali P.  ⏳    │
│         Priya M.         │
│  14:00  Vikram E.  ✓      │
│         Suresh R.        │
│  ... (FlashList)         │
│                         │
├─────────────────────────┤
│  🏠 Dashboard  │  👥  │  │   <- bottom tab bar (5 tabs)
│  📋 Inbox  │ 🔔3 │  ⋯ │  │     native-tabs per Vercel RN
└─────────────────────────┘
```

**Notes:**
- KPI cards are swipeable (`Animated.View` + `useAnimatedScrollOffset`). One KPI per page = full attention per metric.
- Visits list = `FlashList` (`estimatedItemSize: 80`). NOT ScrollView-mapped.
- Bottom tab bar: native tabs (NOT `@react-navigation/bottom-tabs`).

---

## 3. Admin Dashboard - web (cross-team view)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  [Shadhil Metro Heights · CRM]                  🔔0   Priya S. (Admin) ▼  │ top nav   │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  Admin Dashboard                                          [All teams ▼]            │
│                                                                                    │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐                     │
│  │ Total leads  │ Reassignments│ Audit log    │ Users by role│                     │
│  │ (all teams)  │ (last 7 days)│ (last 24h)   │              │                     │
│  │   247        │   18         │   43         │  1 Admin     │                     │
│  │              │              │              │  2 Managers  │                     │
│  │              │              │              │  4 Telecall. │                     │
│  │              │              │              │  3 Sales Ex. │                     │
│  └──────────────┴──────────────┴──────────────┴──────────────┘                     │
│                                                                                    │
│  Team Lead Counts                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ Sales Team A   47 leads    [12 NEW]  [8 VISIT_SCHEDULED]  [View →]      │    │
│  │ Sales Team B   38 leads    [ 9 NEW]  [5 VISIT_SCHEDULED]  [View →]      │    │
│  │ (1 more team)  162 leads   [37 NEW] [28 VISIT_SCHEDULED] [View →]      │    │
│  │ ─────────────────────────────────────────────────────────────────────   │    │
│  │ Total          247                                                  │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
│  Recent admin actions (audit stream - last 10)                  [See all in audit →]│
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ 09:42  Priya S. reassigned lead Rajesh K. from Asha T. to Vikram E.    │    │
│  │ 09:15  Priya S. reassigned lead Priya M.  from Vikram E. to Asha T.     │    │
│  │ 08:30  Priya S. created user Anjali P. (sales_executive)               │    │
│  │ ...                                                                       │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- Same KPI strip pattern as Manager Dashboard. Different metrics.
- Team Lead Counts = `DataTable` with badge columns. "View →" deep-links to filtered Lead Inbox.
- Recent admin actions = live audit stream (last 10). Critical for Admin oversight.

---

## 4. Telecaller "Dashboard" = Lead Inbox - web

The Telecaller's home is the Lead Inbox, **not** a KPI dashboard. Default sort surfaces their next action.

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  [Shadhil Metro Heights · CRM]                  🔔5   Asha T. (Telecaller) ▼      │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  Lead Inbox                                                                       │
│                                                                                    │
│  [🔍 Search]  [Status ▼]  [Source ▼]  [Owner: me ▼]  [Shared with me ☐]            │
│                                                                                    │
│  ☐   Name              Status              Source        Last activity   Owner   │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  ☐ ⚠ Suresh R.         NEW (12m overdue)   Google        12m ago         Asha T.  │
│  ☐ ⚠ Lakshmi N.       NEW (8m overdue)    Meta          8m ago          Asha T.  │
│  ☐   Murali K.         NEW                 Landing form  2m ago          Asha T.  │
│  ☐   Priya M.          CONTACTED           Google        15m ago         Asha T.  │
│  ☐   Rajesh K.         VISIT_SCHEDULED     Meta          1h ago          Asha T.  │
│  ☐   Anjali P.         VISIT_REQUESTED     Google        2h ago          Asha T.  │
│  ...                                                                              │
│                                                                                    │
│  Showing 25 of 142                                [← Prev]  Page 1/6  [Next →]      │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- **Default sort: Overdue first-touch → New → Most recent activity** (Decision 0.2). The first row IS the action.
- ⚠ icon + "12m overdue" badge surfaces overdue leads at the top of the list. Visual urgency.
- No "Reassign" button visible to Telecaller (Admin/Manager only - per §18).
- No bulk actions visible to Telecaller beyond "Mark contacted" + "Add to reminder".
- Filter chips in a single horizontal row. `MultiSelect` for Status + Source. `Switch` for "Shared with me".

---

## 5. Lead Detail - web desktop (1280px+)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  [Shadhil Metro Heights · CRM]                  🔔5   Asha T. (Telecaller) ▼      │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  ← Back to inbox                                                                  │
│                                                                                    │
│  ┌─────────────────────────────────────┐ ┌──────────────────────────────────┐    │
│  │  Rajesh Kumar                       │ │                                  │    │
│  │  +91 98765 43210                    │ │   CHAT                            │    │
│  │  Shadhil Metro Heights · Phase 1   │ │   ────────────────────────────   │    │
│  │                                     │ │                                    │    │
│  │  ┌────────┐  Co-owner: Vikram E.    │ │   [10:42] Rajesh (customer):       │    │
│  │  │ VISIT  │  ─────────────          │ │   "Is parking available?"         │    │
│  │  │ SCHEDU │  Source: Google Ad     │ │                                    │    │
│  │  │ LED    │  Lead age: 2h           │ │   [10:43] Asha (you):              │    │
│  │  └────────┘                        │ │   "Yes, valet available. See       │    │
│  │                                     │ │    you at the site."              │    │
│  │  Next action:                       │ │                                    │    │
│  │  [✓ Mark visited]  [📞 Log call]    │ │   [10:45] Rajesh (customer): ✓    │    │
│  │  [📅 Reschedule]   [⋯ More]         │ │   "Great, on my way."              │    │
│  │                                     │ │                                    │    │
│  │  RERA: TN/02/0345/2024              │ │                                    │    │
│  │                                     │ │   ────────────────────────────   │    │
│  │  [Tab: Overview] Timeline  Notes   │ │   Type a message...                │    │
│  │   Visits   Bookings   Audit        │ │                                    │    │
│  │                                     │ │   [📎] [😊]                       │    │
│  │                                     │ │                                    │    │
│  │  Tabs content here ↓               │ │                                    │    │
│  │  ┌───────────────────────────────┐  │ │                                    │    │
│  │  │  ✓ 10:30  Created             │  │ │                                    │    │
│  │  │  ✓ 10:32  First call (Asha)   │  │ │                                    │    │
│  │  │  ✓ 10:42  WhatsApp reply    │  │ │                                    │    │
│  │  │  ...                          │  │ │                                    │    │
│  │  └───────────────────────────────┘  │ │                                    │    │
│  └─────────────────────────────────────┘ └──────────────────────────────────┘    │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- Two-column layout: left = lead info + tabs, right = embedded chat pane. Chat is permanently visible on desktop.
- Status badge top-left = the current state. Background color = semantic state color.
- "Co-owner: Vikram E." chip shows shared visibility (Model C - per Decision 0.3). Only visible when lead is in VISIT_SCHEDULED state.
- RERA# appears in the lead header (per Decision 1 - compliance footer).
- Tab navigation in a horizontal row: Overview / Timeline / Notes / Visits / Bookings / Audit. **All 6 tabs visible** (not a "More" overflow).
- T-2h sticky banner appears when visit is approaching (Decision 0.10): "Visit at 14:00, Mudichur Phase 1. [Get directions] [Mark on my way]"

---

## 6. Lead Detail - mobile (375px)

```
┌─────────────────────────┐
│ ← Rajesh K.       🔔 ⋯ │   <- top bar
├─────────────────────────┤
│  ┌─────────────────┐    │
│  │ VISIT_SCHEDULED │    │   <- status badge
│  │                 │    │
│  │ Rajesh Kumar    │    │
│  │ +91 98765 43210 │    │
│  │                 │    │
│  │ Co-owner:       │    │
│  │ Vikram E.       │    │
│  └─────────────────┘    │
│                         │
│ ⚠ T-2h visit!            │
│ Visit at 14:00          │
│ Mudichur Phase 1        │
│ [Directions] [On my way]│
│                         │
│  Tabs (5 bottom-nav):    │
│  Overview│ Chat │ Visits│ Bookings │ Notes │
│  ────────┼─────┼────────┼──────────┼───────│
│          │     │        │          │      │
│   (active: Overview)   │
│                         │
│   ┌─────────────────┐  │
│   │ Next action:    │  │
│   │ [✓ Mark visited]│  │
│   │ [📞 Log call]   │  │
│   │ [📅 Reschedule] │  │
│   └─────────────────┘  │
│                         │
│   Timeline (preview):   │
│   ✓ 10:30 Created       │
│   ✓ 10:32 First call    │
│   ✓ 10:42 WhatsApp      │
│   [See full timeline →] │
│                         │
├─────────────────────────┤
│ 🏠 │ 📋 Inbox │  👤 │ ⚙ │   <- bottom tab bar
└─────────────────────────┘
```

**Notes:**
- 5-tab bottom nav (per Decision 0.1): Overview · Chat · Visits · Bookings · Notes.
- Chat is its own tab (not embedded) on mobile - full-screen dedicated view.
- T-2h sticky banner above the tabs is always visible (Decision 0.10).
- "On my way" toggle fires the customer WhatsApp and updates the visit status (Decision 0.10).
- Native tab bar at the bottom (per Vercel RN - native-tabs, NOT JS navigators).

---

## 7. Notification Center - web dropdown panel

```
┌────────────────────────────────────────┐
│  Notifications                  [✓] All │   <- bell dropdown
├────────────────────────────────────────┤
│                                        │
│  Today                                 │
│  ● New lead assigned                   │
│    Murali K. from Google · 2m ago       │
│    [Mark contacted] [⋯]              │
│                                        │
│  ● Handoff: Rajesh K.                  │
│    Telecaller Asha T. handed off       │
│    [Open lead] [⋯]                     │
│                                        │
│  ● Booking awaiting your approval      │
│    Unit B-112 · ₹25L · 5m ago           │
│    [Review] [⋯]                        │
│                                        │
│  Yesterday                              │
│  ○ Visit reminder sent                 │
│    Vikram E. to Rajesh K. · 1d ago      │
│    [Open visit]                        │
│                                        │
│  ─────────────────────────────────────│
│  [See all notifications →]              │
└────────────────────────────────────────┘
```

**Notes:**
- Dropdown panel = max 5-7 items + "See all →" deep link.
- Filled circle ● = unread. Hollow ○ = read.
- Date grouping: Today / Yesterday / This week / Older.
- "Mark all as read" button in header.
- Each notification has a primary action button + "⋯" overflow.
- Empty state: "You're all caught up! 🎉" illustration.

---

## 8. Reassign Dialog - web (Sheet)

Triggered from Lead Inbox (Admin/Manager only):

```
┌─────────────────────────────────────────┐
│ Reassign lead                      [✕] │
├─────────────────────────────────────────┤
│                                         │
│  Lead: Rajesh Kumar (NEW)               │
│  Current owner: Asha T. (Telecaller)    │
│                                         │
│  Reassign to:                            │
│                                         │
│  ○ Telecaller                           │
│    [▼ Vikram E.             ]           │
│       Sales Team A                       │
│                                         │
│  ○ Sales executive                       │
│    [▼ Select sales exec... ]            │
│                                         │
│  Reason (required):                      │
│  ┌─────────────────────────────────────┐│
│  │ Sales exec requested handoff early  ││
│  └─────────────────────────────────────┘│
│                                         │
│  [Cancel]                  [Reassign lead]│
└─────────────────────────────────────────┘
```

**Notes:**
- Built with `Sheet` from `@paalstack/react-ui` (side drawer, right-aligned).
- Two radio options (Telecaller vs Sales exec) - matches the cross-role move allowed per §18 D2.
- Dropdown filtered: Admin sees all teams; Manager sees own team only.
- Reason is **required** - UI blocks submit if empty. Matches §18 audit log requirement.
- "Reassign lead" button calls `POST /leads/:id/reassign` (per §18 endpoint).
- Hidden entirely for Telecaller / Sales Exec (per §18 permission model).

---

## 9. Booking Pipeline - thin slice (Sales Exec view)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Booking - Unit A-204                                                              │
│                                                                                    │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐                                 │
│  │ 1. HOLD ✓  │ → │ 2. TOKEN   │ → │ 3. APPROVAL│                                 │
│  │            │   │            │   │            │                                 │
│  │ Held by    │   │ Receipt    │   │ Manager    │                                 │
│  │ Vikram E.  │   │ required   │   │ review     │                                 │
│  │ Aug 30     │   │            │   │ pending    │                                 │
│  │ 09:15      │   │            │   │            │                                 │
│  └────────────┘   └────────────┘   └────────────┘                                 │
│                          ▲                                                        │
│                          │                                                        │
│                  You are here                                                     │
│                                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │  Upload token receipt                                                   │    │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │    │
│  │  │                                                                 │   │    │
│  │  │          [Drag and drop or click to upload]                    │   │    │
│  │  │                                                                 │   │    │
│  │  │              (PDF, JPG, PNG · max 10 MB)                        │   │    │
│  │  │                                                                 │   │    │
│  │  └─────────────────────────────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  │  [Skip for now]                                  [Upload & submit →]   │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- 3-step `Stepper`: Hold → Token receipt → Manager approval.
- Visual stepper shows current state + completed states.
- Upload area uses `Form` + `Input type="file"` from `@paalstack/react-ui`.
- File storage target: S3-compatible (Backblaze B2 / Cloudflare R2 - per §10).

---

## 10. Site Visit Scheduler - calendar grid (web)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Site Visits - Week of Aug 30, 2026                       [+ Schedule visit]       │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│         Mon 30  │  Tue 31  │  Wed 1   │  Thu 2   │  Fri 3   │  Sat 4  │  Sun 5   │
│  ─────────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────── │
│   09:00        │         │         │         │         │         │            │
│   10:00  Vikram │         │ Anjali  │         │         │         │            │
│         Rajesh │         │ Priya   │         │         │         │            │
│   11:00        │ Vikram  │         │ Anjali  │         │         │            │
│                │ Suresh  │         │ Lakshmi │         │         │            │
│   12:00        │         │         │         │         │         │            │
│   ...                                                                              │
│                                                                                    │
│   Today's count: 5                                                              │
│   This week: 18                                                                │
│   Conflicts: 0                                                                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- Calendar grid: 7 days × hourly slots. Color-coded by exec (Vikram = blue, Anjali = green).
- "Schedule visit" button opens a `Dialog` modal with date/time picker + lead selector.
- For v1: minimal calendar. v1.1: drag-and-drop scheduling, conflict detection.
- Mobile version = agenda list (today + this week), not the grid.

---

## 11. Audit Log - Admin view (web)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Audit Log                                              [Export CSV] [Export JSON] │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  [Date range ▼]  [User ▼]  [Action type ▼]  [Entity type ▼]  [🔍 Search]       │
│                                                                                    │
│  Timestamp         User        Action             Entity        Details        │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  2026-08-30 09:42  Priya S.    LEAD_REASSIGNED     Lead#1234     asha→vikram   │
│  2026-08-30 09:15  Priya S.    LEAD_REASSIGNED     Lead#1235     vikram→asha    │
│  2026-08-30 08:30  Priya S.    USER_CREATED        User#5678     anjali.p      │
│  2026-08-30 08:15  System     NOTIFICATION_SENT    Notif#9991    trigger#5     │
│  2026-08-30 07:50  Vikram E.   VISIT_LOGGED         Visit#432     outcome=VISITED│
│  ...                                                                              │
│                                                                                    │
│  Showing 25 of 4,521                                        [Page 1/181] [Next →]  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- DataTable with sortable columns.
- Filters stack horizontally. Every filter is `MultiSelect` or `DateRangePicker`.
- "Export CSV" + "Export JSON" use the same RERA export mechanism (per §9) - Postgres COPY + cursor pagination.
- 7-year retention (RERA upper bound). Pagination over 4,521 entries suggests a real dataset.
- Each row click → drawer with full details (before/after JSON, IP, user agent).

---

## 12. Notification Center - mobile (full screen)

```
┌─────────────────────────┐
│ ← Notifications      ⋯ │   <- top bar
├─────────────────────────┤
│                         │
│ [All] [Unread] [Leads]   │   <- filter tabs (Tabs from @expo/ui)
│ [Bookings] [Visits]      │
│                         │
│  Today                  │
│  ● Murali K.            │
│    New lead · 2m ago     │
│    [Tap to open]        │
│                         │
│  ● Rajesh K.            │
│    Handoff to you · 5m   │
│    [Tap to open]        │
│                         │
│  ● B-112                │
│    Booking approval     │
│    needed · 15m ago     │
│    [Tap to open]        │
│                         │
│  Yesterday              │
│  ○ Vikram E.            │
│    Visit reminder       │
│    1d ago               │
│                         │
├─────────────────────────┤
│ 🏠 │ 📋 │  🔔 │ 👤 │ ⚙ │   <- bottom tab bar with badge on 🔔
└─────────────────────────┘
```

**Notes:**
- Full-screen list (not dropdown - that's web only).
- Filter tabs use `@expo/ui` `SegmentedControl` for native iOS/Android look.
- `FlashList` for the list (`estimatedItemSize: 120` - taller rows than web dropdown).
- SSE on `user:{id}:notifications` channel for live updates.
- Badge on the 🔔 tab in the bottom bar reflects unread count.

---

## Summary of locked design decisions in these wireframes

| Decision | Source | Effect |
|---|---|---|
| KPI strip not card grid | §4 + §15 | Numbers are inline in a row, not cards |
| 5-tab mobile bottom nav | Decision 0.1 | Overview / Chat / Visits / Bookings / Notes |
| Default sort = overdue first | Decision 0.2 | First row IS the action |
| Co-owner chip | Decision 0.3 | Visible in VISIT_SCHEDULED state |
| 4 Manager KPIs | Decision 0.4 | Time-to-first-touch, visits, approvals, no-show rate |
| T-2h sticky banner | Decision 0.10 | Always visible above tabs |
| Manager-only full-screen modal | Decision 0.11 | Booking approval context |
| Admin cross-team reassign | §18 D1 + D2 | Reassign dialog shows all teams |
| Reassign requires reason | §18 audit | UI blocks submit if empty |
| Cross-role reassign allowed | §18 D2 | Radio: Telecaller / Sales exec |
| Manual bypasses ManagerAssignmentRule | §18 D3 | Manual wins |
| LeadAssignmentHistory table | §18 A10 | New table for reassign analytics |
| Transactional audit | §18 A2 | prisma.$transaction |
| RLS policy per role | §1 + §18 | Admin = all teams; Manager = own team; others = own rows |
| 18 Prisma models | §7 (InAppNotification dropped) | Final schema |
| NestJS 12 | eng review A1 | Updated from DESIGN.md NestJS 10 |

**These wireframes are the canonical reference for implementation. Engineer reads plan §4 (component vocabulary) + this doc for visual reference + §13.1 (perf budgets) + §19 (test plan).**