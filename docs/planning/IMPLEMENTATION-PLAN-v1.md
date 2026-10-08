<!-- /autoplan restore point: /home/paalstack/.gstack/projects/shadhil-crm-plans/main-autoplan-restore-20260831-002701.md -->
# Shadhil Builders CRM - Full Implementation Plan (v1)

**Source design:** `DESIGN.md` v3.1 (1,038 lines, 28 locked decisions)
**Sign-off:** `SIGN-OFF-SUMMARY-v3.1.md` (6 client inputs required before Week 1)
**Plan-mode review:** `.gops/skills/gstack-plan-design-review` skill output (this directory's audit)
**Stack lock:** Monorepo (pnpm + Turborepo), Next.js 16 (BFF + web UI), NestJS 12 (REST backend - locked by user 2026-08-30, supersedes DESIGN.md §7 NestJS 10 reference), Expo (mobile), Prisma (DB), better-auth (auth), @paalstack/react-ui (component lib)
**Target:** Week 13 → v1 live on Hostinger VPS via Coolify
**Status:** Plan ready, awaiting client sign-off + the 6 inputs from SIGN-OFF doc

---

## 0. Design Decisions Locked (from /plan-design-review)

These 11 P1 decisions are baked into this plan with recommended defaults. Override before Week 4 if needed.

| # | Decision | Default | Rationale |
|---|---|---|---|
| 0.1 | Mobile Lead Detail tab order | Overview → Chat → Visits → Bookings → Notes (5 tabs) | High-frequency actions up front |
| 0.2 | Telecaller inbox default sort | Overdue first-touch → New → Most recent activity | Time-to-first-touch is KPI #1 |
| 0.3 | Shared-visibility affordance | "Co-owner: <name>" chip + "Shared with me" filter chip | Telecaller+exec share during VISIT_SCHEDULED |
| 0.4 | Manager dashboard KPIs | Time-to-first-touch (today), Today's visits, Awaiting approval, Yesterday's no-show rate | Maps to §13 metrics |
| 0.5 | Empty state illustrations | Single monochrome line-art set, undraw.co or streamlinehq | Consistent, lightweight |
| 0.6 | Skeleton fidelity rule | Skeletons mirror real component shape (real layout, greyed text) | Avoids layout shift on load |
| 0.7 | Optimistic update strategy | Save-as-draft locally for chat; optimistic with rollback for status transitions | TanStack Query config |
| 0.8 | Model C handoff choreography | Toast on both screens + bell notification + banner on Lead Detail ("You took over from <name>") | Emotional acknowledgment matters |
| 0.9 | First-time login onboarding | Admin: empty setup; Other roles: 1-screen intro ("Your queue. Tap a lead.") | Admin is configurator; others are operators |
| 0.10 | Visit-approaching state (T-2h) | Sticky banner: "Visit at <time>, <location>. [Directions] [On my way]" | Increases conversion |
| 0.11 | Booking approval flow | Admin/Owner: full-screen modal (not drawer) for context (2026-09-24: Manager revoked, and the earlier "Sales exec: drawer for quick approve" was never true - exec initiates, does not approve) | Approver needs to see booking details + lead context |

---

## 1. Monorepo Architecture

### Structure

```
shadhil-crm/
├── apps/
│   ├── web/              # Next.js 16 (BFF + web UI + notification inbox)
│   ├── mobile/           # Expo (React Native)
│   └── backend/          # NestJS 12 (REST API)
├── packages/
│   ├── database/         # @shadhil/database - Prisma schema + generated client
│   ├── api-types/        # @shadhil/api-types - Re-exports Prisma types + manual request/response types
│   ├── auth-client/      # @shadhil/auth - Shared better-auth server instance + helpers (web + mobile)
│   └── ui-tokens/        # @shadhil/ui-tokens - Brand tokens (#001a4c, #62b132, #f8f5ef)
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── .env.example
```

### Tooling per workspace (from skills installed)

- **`turborepo-monorepo`** skill → `pnpm create turbo@latest`, `turbo.json` with `dependsOn: ["^build"]`, transit nodes for parallel typecheck, `outputs: [".next/**", "dist/**"]`
- **`monorepo-management`** skill → workspace conventions, package manager config
- **`better-auth-best-practices`** skill → `auth.ts` in `apps/web/lib/auth.ts`, `BETTER_AUTH_SECRET` env, Prisma adapter at `packages/database`, `npx @better-auth/cli@latest generate --output packages/database/prisma/schema.prisma`
- **`tailwind-design-system`** skill → CSS variables for brand tokens in `packages/ui-tokens/tokens.css`, `@theme inline` in `apps/web/src/app/globals.css`, semantic-only utilities
- **`expo-native-ui`** skill (inline-loaded via `npx skills use`) → `@expo/ui` for sheets/pickers/sliders/menus/sections; SF Symbols via `expo-image` with `source="sf:name"`; `Color` from `expo-router` for semantic colors wrapped in `Platform.select`; `expo-router/react-navigation` (never `@react-navigation/*` direct); Reanimated v4 for animations
- **`expo-tailwind-setup`** skill (inline-loaded) → Tailwind v4 + `react-native-css` + NativeWind v5 for universal mobile/web styling. **NO `babel.config.js`** for Tailwind in Expo. PostCSS uses `@tailwindcss/postcss`. CSS imports use `@import "tailwindcss/theme.css"` / `preflight.css` / `utilities.css`. `@theme` in CSS (NOT `tailwind.config.js`). Components wrapped via `useCssElement` for className support. Install: `tailwindcss@^4 nativewind@5.0.0-preview.2 react-native-css@0.0.0-nightly.5ce6396 @tailwindcss/postcss tailwind-merge clsx`. Resolution: `lightningcss: 1.30.1`. Apple semantic colors via `platformColor()` in `@media ios` blocks + `light-dark()` fallback for web/Android.
- **`vercel-react-native-skills`** skill (inline-loaded) → FlashList for ALL lists (NOT ScrollView-mapped, NOT FlatList). Memoize list items, stabilize callbacks, avoid inline objects. Animate only `transform`/`opacity` (GPU). Use native stack + native tabs (NOT JS navigators). Use `expo-image` for all images. Use `Pressable` over `TouchableOpacity`. `onLayout` over `measure()`. Native deps stay in app package (monorepo). Single dependency versions across workspace.

### Data ownership (DESIGN.md §8)

- **Next.js BFF** writes to auth tables only (User, Session, Account, Verification) via better-auth Prisma adapter
- **NestJS** writes to all business tables via REST controllers + webhook receivers
- **Mobile** calls NestJS REST, never touches Prisma directly
- **Server components** call NestJS REST, do not query business tables directly (exception: read User for profile)
- Migrations run from `apps/backend` (`pnpm prisma migrate dev`)
- PgBouncer in **session pooling mode for v1** (RLS works with per-request session vars). Switch to transaction pooling in v2 when concurrent users exceed ~50.
- **Guard rail (eng review 2026-08-30, A5):** `POOL_MODE=session` is REQUIRED. Transaction pooling silently breaks RLS - users see each other's data. Add a Coolify env-validation check at NestJS boot that fails startup if `POOL_MODE != session`.
- **Connection budget (eng review 2026-08-30, P1):** Postgres `max_connections = 300`. With 2 SSE streams/user × 150 users = 300 concurrent backend sessions. Above that, scale Postgres vertically or move to active-screen SSE pattern.

### Initial scaffold (Week 1)

```bash
# From /home/paalstack/workspace/shadhil-projects/
cd /home/paalstack/workspace/shadhil-projects
git init shadhil-crm
cd shadhil-crm
git remote add origin git@github.com:paalstack/shadhil-crm.git

# Initialize monorepo skeleton (per turborepo-monorepo skill)
pnpm create turbo@latest . --no-git
pnpm add -D -w turbo
# Configure turbo.json per skill: pipeline.build, pipeline.test, pipeline.lint
# Pipeline patterns: { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] }

# Copy web app from paalstack-nextjs-starter template (skip the Supabase bits, add our stack)
cp -r /home/paalstack/workspace/paalstack-nextjs-starter/{src,public,.eslintrc*,tsconfig.json,next.config.*,postcss.config.*,Dockerfile,docker-compose.yml} apps/web/

# Init NestJS backend (per next-app config)
pnpm dlx @nestjs/cli new apps/backend --package-manager pnpm --skip-git
```

---

## 2. Phased Build (13 weeks, mapped to DESIGN.md §15)

Each phase has a clear deliverable, a checkpoint, and a verification gate.

### Phase 1 - Infrastructure & Schema (Weeks 1–2)

**Week 1: Monorepo skeleton + VPS provisioning**

- [ ] Initialize git repo, push to `github.com/paalstack/shadhil-crm` (private)
- [ ] Set up Turborepo per `turborepo-monorepo` skill (pipeline + outputs + dependsOn)
- [ ] Create workspace structure (`apps/web`, `apps/mobile`, `apps/backend`, `packages/{database,api-types,auth-client,ui-tokens}`)
- [ ] Configure `pnpm-workspace.yaml` and root `package.json` (per `monorepo-management` skill)
- [ ] Provision Hostinger VPS 8GB India region
- [ ] Install Coolify on VPS, configure DNS for `crm.shadhilbuilders.in` and `api.crm.shadhilbuilders.in`
- [ ] SSL via Let's Encrypt (Coolify auto)
- [ ] Set up Docker Compose on VPS: NestJS, Postgres 16, PgBouncer, Redis 7
- [ ] Initialize `apps/web` from `paalstack-nextjs-starter` template
- [ ] Strip Supabase dependencies, install better-auth per `better-auth-best-practices` skill
- [ ] Initialize `apps/backend` from NestJS CLI
- [ ] Submit 4 WhatsApp templates to Meta for production approval
- [ ] Skeleton monorepo runs locally (`pnpm dev` starts all 3 apps) AND on VPS via Coolify

**Verification:** `pnpm turbo run build --dry-run` shows correct task graph; VPS serves a placeholder page at both subdomains.

**Week 2: Prisma schema + RLS + NestJS basics**

- [ ] Define `packages/database/prisma/schema.prisma` - 18 models (User, Team, Project, Phase, Unit, Lead, Activity, SiteVisit, Message, Booking, Reminder, Notification, PushSubscription, PushNotification, AuditLog, Consent, WebhookEvent, ManagerAssignmentRule). See §7 for the full list. `InAppNotification` was DROPPED in eng review C2.
- [ ] RLS policies written per row (DESIGN.md §8: per-request session vars)
- [ ] First Prisma migration applied
- [ ] NestJS modules scaffolded: `AuthModule`, `LeadsModule`, `VisitsModule`, `ChatModule`, `BookingsModule`, `RemindersModule`, `NotificationsModule`, `AuditModule`, `WebhooksModule` (WhatsApp, FreJun)
- [ ] basic-auth integrated per `better-auth-best-practices` skill:
  - `apps/web/lib/auth.ts` with Prisma adapter
  - `apps/web/app/api/auth/[...all]/route.ts` catch-all
  - `BETTER_AUTH_SECRET` in env (32+ chars from `openssl rand -base64 32`)
- [ ] `@nestjs/swagger` for auto-generated OpenAPI at `/api/docs`
- [ ] CORS allowlist on both Next.js and NestJS (half-day task per DESIGN.md §8)
- [ ] **Deliverable:** Schema live, RLS proven

**Verification:** Auth login works locally; RLS test suite proves row-level isolation; OpenAPI docs render.

### Phase 2 - Auth & Lead Foundation (Weeks 3–4)

**Week 3: better-auth + JWT bridge**

- [ ] Login/logout flows working on web
- [ ] `authClient` from `better-auth/react` for web
- [ ] `authClient` from `@better-auth/expo` for mobile (uses `expo-secure-store` for token persistence)
- [ ] JWT issuance + verification (HS256 per DESIGN.md §8)
- [ ] NestJS `JwtStrategy` (`@nestjs/passport`) verifies with shared secret using `jose`
- [ ] Postgres session vars set per request (for RLS)
- [ ] Three users provisioned for testing (1 admin + 1 manager + 1 telecaller - required by end of Week 3 per SIGN-OFF input #5)
- [ ] **Deliverable:** Auth works on both surfaces

**Verification:** Sign in on web → JWT issued → REST call to NestJS with Bearer → RLS filters correctly. Repeat on mobile.

**Week 4: Lead CRUD + Lead Inbox + state machine**

- [ ] Lead CRUD via REST (`GET/POST/PATCH/DELETE /leads`)
- [ ] Lead state machine implementation (Model C - see §3)
- [ ] RLS enforcement tested per role
- [ ] Site Visit basic CRUD (`GET/POST/PATCH /visits`)
- [ ] TanStack Query hooks (`useLeads`, `useLead`, `useUpdateLeadStatus`)
- [ ] **Lead Inbox page** on web:
  - DataTable from `@paalstack/react-ui` (sortable, filterable)
  - Default sort: **Overdue first-touch → New → Most recent activity** (Decision 0.2)
  - Filter chips: Status, Source, Owner, "Shared with me"
  - Bulk actions: Reassign, Mark contacted, Add to reminder
  - Empty state: "No leads match these filters. [Clear filters]"
  - Empty state (no data at all): "No leads yet - they'll appear here as soon as the landing-site webhook fires."
- [ ] **Lead Detail page** on web - desktop layout:
  - Top: Status banner (with next-action CTA), lead name, phone, source, co-owner chip
  - Tabs: Overview / Timeline / Notes / Chat / Visits / Bookings
  - Overview: contact info, next action, recent activity snippet, key dates
  - Timeline: ActivityTable (call, message, status change, visit logged)
  - Notes: rich text + @mentions
  - Chat: embedded chat pane (right column on desktop, full-screen on mobile)
  - Visits: scheduled + past visits with outcomes
  - Bookings: thin-slice booking pipeline
- [ ] Mobile Lead Inbox: card list (1 lead per card)
- [ ] Mobile Lead Detail: 5-tab bottom nav (Overview, Chat, Visits, Bookings, Notes - Decision 0.1)
- [ ] **Deliverable:** Lead Inbox functional

**Verification:** Create lead → appears in inbox → status transitions work → Lead Detail renders all tabs → RLS prevents cross-team reads.

### Phase 3 - Realtime & Messaging (Week 5)

**Week 5: Chat pane + SSE + WhatsApp + Lead Detail polish**

- [ ] SSE endpoint `GET /leads/:id/stream` (chat) on NestJS
- [ ] SSE endpoint `GET /notifications/stream` (inbox)
- [ ] SSE endpoint `GET /reminders/stream` (banner)
- [ ] Redis pub/sub channels: `lead:{id}:messages`, `user:{id}:notifications`, etc. (DESIGN.md §9)
- [ ] ChatPane component (web): bubbles, optimistic local save, "Delivered ✓" → "Read ✓" status
- [ ] ChatPane component (mobile): dedicated route, virtualized message list
- [ ] WhatsApp webhook handler in NestJS - receives → creates message → broadcasts via SSE → archives
- [ ] "Send WhatsApp" button in Lead Detail → calls WhatsApp Cloud API → publishes to SSE → user sees message
- [ ] **Deliverable:** Chat works, WA inbound flows

**Verification:** Send WhatsApp from external phone → appears in Lead Detail chat within 2s. Send from CRM → arrives on customer's phone.

### Phase 4 - Visits, Handoffs, Notifications (Week 6)

**Week 6: Site Visit scheduler + Model C handoff**

- [ ] Site Visit Scheduler UI (web): calendar grid + slot picker
- [ ] Site Visit list (mobile): agenda view (today + this week)
- [ ] Site Visit outcomes: VISITED, NO_SHOW, RESCHEDULED, CANCELLED
- [ ] **Model C handoff flow** (DESIGN.md §3):
  - On outcome=VISITED → transfer ownership to assigned exec, log handoff event, toast both screens (Decision 0.8)
  - On outcome=NO_SHOW → revert ownership to telecaller, fire no-show reminder
  - On outcome=RESCHEDULED → cancel old visit reminders, schedule new ones
- [ ] FreJun webhook handler (stub for v1 - full telephony in Week 11)
- [ ] Notification triggers 1–4 + 8–10 wired (DESIGN.md §10)
- [ ] Push token storage (PushSubscription table)
- [ ] **Deliverable:** Site visits + handoffs work

**Verification:** Visit marked VISITED → toast on both screens → exec now owns → audit log entry. Visit marked NO_SHOW → reverts to telecaller → no-show reminder fires.

### Phase 5 - Reminders, Booking, Inbox, Audit (Week 7)

**Week 7: Reminders + Notification Center + Inventory + Booking + Audit**

- [ ] Reminders module: schema, cron, 4 types (pre-visit staff/customer, reschedule, no-show - DESIGN.md §12)
- [ ] Reminder processor (NestJS `@Cron('* * * * *')`)
- [ ] Notification Center UI on web:
  - Bell icon in top nav, badge capped at "9+"
  - Dropdown panel (5–7 items max + "See all" → `/notifications` full page)
  - Filter tabs: All / Unread / Leads / Bookings / Visits
  - Empty state: "You're all caught up! 🎉"
- [ ] Notification Center UI on mobile (Week 8 mobile polish)
- [ ] Inventory grid (web):
  - DataTable with columns: Villa #, BHK, Facing, Sqft, Price, Status
  - Filters: Project, Phase, BHK, Facing, Status
  - Click unit → detail panel with hold + booking flow
- [ ] Booking pipeline (thin slice):
  - Stepper: Hold → Token receipt → Admin/Owner approval
  - Token receipt upload (file input → S3-compatible storage)
  - Admin/Owner approval modal (Decision 0.11: full-screen, not drawer)
- [ ] Audit log writer: every login, lead view, state transition, message, call, consent change
- [ ] **Deliverable:** Reminders + Inbox work on web

**Verification:** Schedule visit → T-2h push fires to exec → reminder banner shows on Lead Detail (Decision 0.10). Create booking → admin/owner receives notification → approves → audit log entry.

### Phase 6 - Mobile Push + Notifications + Manager Dashboard (Weeks 8–9)

**Week 8: Mobile notifications + Manager handoff E2E**

- [ ] Notification Center UI on mobile:
  - Full-screen list (not dropdown panel)
  - Tab bar badge
  - SSE on `user:{id}:notifications` channel
  - Tap item → deep-link to lead/visit/booking
- [ ] Push notification setup (Expo Push + VAPID keys)
- [ ] All 12 push triggers wired (DESIGN.md §10)
- [ ] Push receipt polling (every 5 min) - update `DELIVERED` / `FAILED` status
- [ ] Quiet hours logic (22:00–07:00 local) - reminder triggers defer, state-transition triggers fire anyway
- [ ] Manager handoff flow E2E (manager reviews team pipeline, reassigns, initiates bookings)
- [ ] **Deliverable:** Push + Inbox work on mobile

**Verification:** Trigger event on web → push arrives on phone within 30s. Quiet hours enforced. Receipt confirms delivery.

**Week 9: Manager dashboard + Compliance**

- [ ] **Manager dashboard** (web): KPI strip + queue (Decision 0.4)
  - KPI 1: Time-to-first-touch (today's median, with target threshold line)
  - KPI 2: Today's scheduled visits (count + breakdown by exec)
  - KPI 3: Bookings awaiting approval (count + oldest age)
  - KPI 4: Yesterday's no-show rate (with trend indicator)
  - Below KPIs: Manager's team pipeline (visits today, bookings in progress, overdue leads)
- [ ] Manager dashboard mobile: 4 KPI cards swipeable
- [ ] RERA compliance:
  - Consent capture flow (DPDP Act)
  - Right-to-erasure workflow (Admin only)
  - Project-level data export (per-project JSON dump for inspector)
- [ ] **Deliverable:** Compliance + dashboard work

**Verification:** Manager sees dashboard at 9 AM, identifies stalled lead in <30s. RERA export produces JSON within 30s for 100k-row dataset.

### Phase 7 - Mobile App Build (Week 10)

**Week 7 store-review gate (ratified at /autoplan gate 2026-08-31, decision A):**
- [ ] Submit a TestFlight (iOS) + internal-testing-track (Android) build by EOD Week 7 - bare login + Lead Inbox is enough. Purpose: start Apple/Google review latency outside the critical path.
- [ ] Hold a 2-week review buffer: Week 11-13 can absorb one rejection cycle without slipping v1 live.
- [ ] If store review threatens Week 13: PWA install flow (already Phase 10) is the documented fallback for field web-as-mobile use.

**Week 10: Expo mobile app**

**Setup (per `expo-tailwind-setup` skill):**
- [ ] Initialize `apps/mobile` with Expo SDK 56+
- [ ] Install mobile Tailwind: `tailwindcss@^4 nativewind@5.0.0-preview.2 react-native-css@0.0.0-nightly.5ce6396 @tailwindcss/postcss tailwind-merge clsx`
- [ ] Add resolution: `"lightningcss": "1.30.1"` in root package.json
- [ ] **`metro.config.js`** with `withNativewind({ inlineVariables: false, globalClassNamePolyfill: false })`
- [ ] **`postcss.config.mjs`** with `@tailwindcss/postcss` plugin
- [ ] **`apps/mobile/src/global.css`** with `@import "tailwindcss/theme.css" layer(theme)` / `preflight.css` layer(base)` / `utilities.css`
- [ ] **NO `babel.config.js`** for Tailwind (per skill - delete if present)
- [ ] **`apps/mobile/src/tw/index.tsx`** - wrap View, Text, ScrollView, Pressable, TextInput, Link via `useCssElement`
- [ ] Brand tokens: `@theme { --color-brand-primary: #001a4c; ... }` in global.css (sharing with web via `packages/ui-tokens`)
- [ ] Apple semantic colors via `platformColor()` in `@media ios` blocks + `light-dark()` fallback

**Architecture (per `expo-native-ui` + `vercel-react-native-skills` skills):**
- [ ] Expo Router setup - use `expo-router/react-navigation` (NOT direct `@react-navigation/*` imports)
- [ ] **Native stack + native tabs only** (`@react-navigation/native-stack` or expo-router's default stack - NOT `@react-navigation/stack` or `/bottom-tabs`)
- [ ] **`Color` from `expo-router`** for semantic colors in `apps/mobile/theme/colors.ts` with `Platform.select` wrappers
- [ ] **SF Symbols via `expo-image` with `source="sf:name"`** (NOT `expo-symbols` or vector-icons)
- [ ] **`@expo/ui`** for Switch, Slider, DateTimePicker, Menu, SegmentedControl, BottomSheet - renders as native SwiftUI/Compose
- [ ] **Reanimated v4** for animations (NOT built-in Animated API) - animate only `transform` and `opacity` (GPU-accelerated)
- [ ] **`useWindowDimensions()`** over `Dimensions.get()` for responsive layout
- [ ] **`onLayout`** over `measure()` for view measurements
- [ ] **`Pressable`** over `TouchableOpacity` everywhere

**Critical list rules (Vercel RN - applies to Lead Inbox, Notification Center, Chat pane, Site Visit list):**
- [ ] **FlashList** for ALL lists (NOT ScrollView-mapped, NOT FlatList) - `import { FlashList } from '@shopify/flash-list'`
- [ ] **`estimatedItemSize`** set per list (e.g., 80 for Lead row, 120 for Notification, 88 for chat bubble)
- [ ] Memoize list item components (`React.memo`)
- [ ] Stabilize callback references (`useCallback` for `renderItem`, `keyExtractor`)
- [ ] No inline style objects in list items (use `StyleSheet.create`)
- [ ] Extract functions outside render
- [ ] Use item types for heterogeneous lists (`getItemType`)
- [ ] Optimize images in lists with `expo-image` (caching + transitions)

**Screens (per design decisions in §0):**
- [ ] Login screen + Lead Inbox (FlashList) + Lead Detail (5-tab bottom nav)
- [ ] Visit Scheduler (mobile-optimized calendar)
- [ ] Booking view + Booking Approval (manager mobile, native modal)
- [ ] Chat pane (FlashList virtualized, message bubbles)
- [ ] Notification Center (FlashList, badge on tab bar)

**Conditional rendering rules (Vercel RN):**
- [ ] **Never** use `falsy &&` for conditional rendering - use ternaries that always return valid React nodes (`cond ? <Component /> : null`)
- [ ] **Always** wrap text in `<Text>` (NOT `<View>{string}</View>`)
- [ ] Use native context menus for row actions (long-press)
- [ ] Use native modals where possible (NOT custom JS modals)

**Build & deploy:**
- [ ] Build for App Store + Play Store via EAS
- [ ] **Deliverable:** Mobile app submitted

**Verification:**
- Login on phone → Lead Inbox scrolls smoothly (FlashList, 60fps with 1000+ leads)
- Open lead → Chat pane renders 500+ messages without jank (FlashList virtualized)
- Trigger push → arrives within 30s on iOS + Android
- All animations 60fps (transform/opacity only)

### Phase 8 - Production Integrations (Week 11)

**Week 11: Real WhatsApp + FreJun testing**

- [ ] WhatsApp production number activated (depends on Meta approval - may need to wait)
- [ ] 4 templates approved and active (submitted Week 1)
- [ ] FreJun sign-off complete (SIGN-OFF input #4)
- [ ] Real phone numbers provisioned for staff (SIGN-OFF input #6)
- [ ] FreJun webhook live - incoming calls logged, recordings archived to Cloudflare R2
- [ ] AI transcription enabled (FreJun built-in)
- [ ] E2E tests: customer calls → lands in lead timeline → recording plays in chat pane
- [ ] **Deliverable:** Real integrations working

**Verification:** Real customer calls come in → recordings appear in CRM within 60s.

### Phase 9 - Production Deploy (Week 12)

**Week 12: Deploy to Hostinger via Coolify**

- [ ] Dockerfiles for `apps/web` and `apps/backend` (multi-stage builds, non-root user)
- [ ] Coolify deploy from GitHub (main branch auto-deploy)
- [ ] Production environment variables set in Coolify (DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, JWT_SECRET, WhatsApp creds, FreJun creds, Expo Push creds, VAPID keys, R2 creds)
- [ ] SSL verified (Coolify auto)
- [ ] Subdomains live: `crm.shadhilbuilders.in` + `api.crm.shadhilbuilders.in`
- [ ] Smoke test in production:
  - Login → JWT → REST call → SSE stream
  - Lead Inbox loads
  - Chat pane live
  - Push notification fires
- [ ] **Monitoring + alerting active:**
  - Better Stack uptime (free tier)
  - Sentry error tracking (free tier)
  - Health check endpoint on both apps (every 30s)
- [ ] **Backups configured:**
  - Daily Postgres dump to Backblaze B2
  - Weekly restore test (cron job validates backup integrity)
- [ ] **RUNBOOK.md written:** incident response, backup verification, Coolify upgrade procedure
- [ ] **Deliverable:** First production deployment

**Verification:** All 9 modules respond. SSE streams work. Push fires end-to-end. Backup verified.

### Phase 10 - Bug Fixes + Polish (Week 13)

**Week 13: Production bug fixes + PWA + Final QA**

- [ ] Bug triage from production usage
- [ ] Performance tuning (slow queries, bundle sizes, SSE reconnect logic)
- [ ] PWA install flow on iOS Safari (for v1 web-as-mobile)
- [ ] Final QA pass: all 9 modules, all 4 roles, all critical paths
- [ ] Handoff documentation: RUNBOOK.md, DEPLOY.md, ARCHITECTURE.md
- [ ] Client training session (recorded)
- [ ] **Deliverable:** v1 done, ready for handoff

---

## 3. Model C State Machine - Implementation Detail

From DESIGN.md §3. The state machine that the entire lead flow orbits around.

```
States:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED → VISITED → NEGOTIATION → BOOKING_INITIATED → WON | LOST
                                                                                                          ↓
                                                                                                        RNR
  Side states: RESCHEDULED, NO_SHOW, CANCELLED (terminal for that visit instance)

Ownership rules:
  - NEW through VISIT_SCHEDULED: Telecaller owns
  - VISIT_SCHEDULED: Telecaller owns, Sales Exec has shared visibility (both see in queue, both see "Co-owner" chip)
  - VISITED onwards: Sales Exec owns
  - NO_SHOW: reverts to Telecaller (re-engagement)
  - RESCHEDULED: stays Telecaller (they re-confirm)
  - WON / LOST / RNR: terminal, no owner (Admin can reassign)
```

**Implementation in NestJS** (`apps/backend/src/leads/`):

```typescript
// lead-state-machine.ts
type TransitionContext = {
  leadId: string;
  userId: string;
  userRole: Role;
  outcome?: 'VISITED' | 'NO_SHOW' | 'RESCHEDULED' | 'CANCELLED';
  rescheduledFromId?: string;
};

function transitionLead(ctx: TransitionContext): LeadState {
  // Validation per role: who can do what
  // Audit log entry on every transition
  // Notification triggers fire on ownership changes
  // SSE publishes on user's notifications channel
}
```

**Prisma schema sketch:**

```prisma
enum LeadState {
  NEW CONTACTED VISIT_REQUESTED VISIT_SCHEDULED
  VISITED NEGOTIATION BOOKING_INITIATED
  WON LOST RNR RESCHEDULED NO_SHOW
}

enum LeadOwnerType { TELECALLER SALES_EXEC MANAGER ADMIN }

model Lead {
  id            String      @id @default(cuid())
  name          String
  phone         String      @unique
  source        String
  state         LeadState   @default(NEW)
  ownerId       String
  ownerType     LeadOwnerType
  coOwnerId     String?     // For VISIT_SCHEDULED shared visibility
  teamId        String
  projectId     String?
  // ... activity, visits, messages, bookings (related models)
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@index([ownerId, state])
  @@index([teamId, state])
}
```

---

## 4. UI Component Vocabulary (locked - Decision from §0.3)

From `~/.hermes/skills/devops/paalstack-react-ui/SKILL.md` (the consumer-side PaalStack design system). Every module uses components from this list. No custom rebuilds.

| Module | Components used |
|---|---|
| Lead Inbox | `DataTable`, `MultiSelect`, `DateRangePicker`, `Badge`, `Avatar`, `DropdownMenu`, `Sheet` (filter drawer on mobile) |
| Lead Detail | `Tabs`, `Card` (status banner), `ButtonGroup`, `Form`+`Input`+`Textarea`, `Sheet` (actions drawer), `Toast` |
| Chat pane | `ScrollArea`, `Avatar`, `EmptyState`, `Toast`, custom message bubbles via `Box` |
| Site Visit Scheduler | `Calendar` (custom from primitives), `Dialog` (reschedule modal), `Badge` |
| Inventory | `DataTable`, `Card` (unit card on mobile), `MultiSelect` (project/phase/BHK/facing) |
| Booking Pipeline | `Stepper`, `Form`, `Dialog` (admin/owner approval), `Badge` |
| Reminders | `Card` (banner), `Switch`, `Select` (timing) |
| Audit Log | `DataTable`, `DateRangePicker`, filter chips |
| Notification Center | `DropdownMenu` (bell panel), `DataTable` (full page), `Tabs` (filter), `Badge` (count) |

**Tokens (in `packages/ui-tokens/tokens.css`):**

```css
:root {
  --color-brand-primary: #001a4c;       /* deep navy */
  --color-brand-secondary: #62b132;     /* green */
  --color-surface: #f8f5ef;             /* warm off-white */
  --color-state-visited: #16a34a;       /* green */
  --color-state-no-show: #dc2626;       /* red */
  --color-state-rescheduled: #f59e0b;   /* amber */
  --color-state-pending: #6b7280;       /* grey */
}

[data-theme="dark"] {
  /* Out of scope for v1 */
}

@theme inline {
  --color-primary: var(--color-brand-primary);
  --color-primary-foreground: #ffffff;
  --color-secondary: var(--color-brand-secondary);
  --color-secondary-foreground: #ffffff;
  --color-background: var(--color-surface);
  /* ... etc */
}
```

**Typography:** `IBM Plex Sans` (open, professional, supports Devanagari/Tamil for v1.2). NOT Inter (AI slop). NOT Geist (cleaner but less character). Locked for v1.

**Icon library:** `lucide-react` via `@paalstack/react-icons/lu` (already in react-ui). Forbid new icon packages.

**Negative spec (AI slop blacklist):**
- No purple gradients
- No card grids for data-dense screens (use DataTable)
- No decorative blobs/wavy dividers
- No icons in colored circles (use lucide directly)
- No stock photos
- No emoji as design elements (except in empty-state illustrations)
- No uniform bubbly border-radius (use `borderCurve: 'continuous'` per `expo-native-ui`, varied on web)
- No `border-left: 3px solid` colored bars on cards

---

## 5. Realtime Architecture (SSE)

Three SSE channels: **chat** (per-lead message stream), **notifications**
(current-user Notification inbox), **audit** (current-user AuditLog
visibility, with ADMIN/OWNER see-all as in the REST list).

### 5.0 Subdomain allocation (locked 2026-09-04)

| Subdomain | Service | Port | TLS | Why |
|---|---|---|---|---|
| `crm.shadhilbuilders.in` | Next.js web (apps/web) | 3000 → 443 via reverse proxy | yes (h2) | User-facing SPA; better-auth session cookie scoped to this host only |
| `api.crm.shadhilbuilders.in` | NestJS backend (apps/backend) | 8080 → 443 via reverse proxy | yes (h2) | Auth-gated REST API; also owns `POST /api/realtime/ticket` (JWT-gated) |
| `sse.crm.shadhilbuilders.in` | Standalone SSE service (apps/realtime-sse) | 8090 → 443 via reverse proxy | yes (h2) | Long-lived `EventSource` connections, no cookies (StreamTicket in URL) |

**Why a distinct subdomain for SSE, not a path on the API:**

1. **Cookie isolation.** The ticket in the SSE URL is the auth credential. If
   `sse.*` and `api.*` were siblings under `crm.shadhilbuilders.in`, the
   browser would send the `better-auth.session_token` cookie on every SSE
   request - expanding the cookie's attack surface (XSS in one site
   exfiltrates the other). A separate subdomain scopes the cookie to the
   API only; the SSE connection authenticates purely via the
   unguessable 5-min single-use cuid.
2. **HTTP/2 multiplexing pool isolation.** Per the MDN warning on
   `EventSource`: HTTP/1.1 caps 6 connections per origin per browser
   instance, marked "Won't fix" in Chrome + Firefox. With SSE on its own
   subdomain, the h2 connection pool for SSE is separate from the
   API's, so a misbehaving SSE handler can't exhaust stream IDs and
   starve the API's normal traffic.
3. **Operational visibility.** Long-lived connections have a different
   operational shape (timeouts, keep-alive, proxy buffering) from
   short-lived REST. Putting them on a distinct subdomain makes
   firewall rules, log dashboards, and rate-limit policies easier to
   reason about.

### 5.1 Topology in production

```
Browser
  │
  ├─ https://crm.shadhilbuilders.in/             (Next.js, Vercel or self-hosted)
  │
  ├─ https://api.crm.shadhilbuilders.in/...        (Traefik → NestJS, :8080)
  │   └─ POST /api/realtime/ticket   (mint a 5-min single-use StreamTicket)
  │
  └─ https://sse.crm.shadhilbuilders.in/api/sse/...  (Traefik → apps/realtime-sse, :8090)
      ├─ /api/sse/notifications?ticket=<cuid>
      ├─ /api/sse/audit?ticket=<cuid>
      └─ /api/sse/chat/:leadId?ticket=<cuid>
```

**Reverse proxy - single Traefik (Coolify default).** All three
subdomains route through Coolify's built-in Traefik. The SSE
service uses Docker labels for per-route config (compress
exclusion). No dedicated reverse-proxy container needed; no
Caddyfile to author by hand.

SSE service Docker labels (set in Coolify's per-service config or
the `docker-compose.yml` deployable resource):

```yaml
labels:
  - "traefik.enable=true"
  # Router: match the SSE subdomain
  - "traefik.http.routers.sse.rule=Host(`sse.crm.shadhilbuilders.in`)"
  - "traefik.http.routers.sse.entrypoints=websecure"
  - "traefik.http.routers.sse.tls=true"
  - "traefik.http.routers.sse.tls.certresolver=letsencrypt"
  # Skip compression on SSE routes (compression breaks streaming)
  - "traefik.http.routers.sse.middlewares=no-sse-compress"
  - "traefik.http.middlewares.no-sse-compress.compress=true"
  - "traefik.http.middlewares.no-sse-compress.compress.excludedcontenttypes=text/event-stream"
  # Service: route to the standalone SSE container
  - "traefik.http.services.sse.loadbalancer.server.port=8090"
```

**Why no explicit `flushInterval` config:** Traefik auto-detects
streaming responses when `Content-Type: text/event-stream` is set
(per official Traefik v3 docs: "FlushInterval is ignored when
ReverseProxy recognizes a response as a streaming response"). The
standalone service already sets that header on its own `writeHead`,
so the right `Content-Type` is enough.

**Why this beats the Caddy split I considered earlier (decision
audit #35 superseded 2026-09-04):** Coolify is built around
Traefik - every tutorial, every issue thread, every GH discussion
in coollabsio/coolify assumes Traefik. Caddy has known override
bugs in Coolify's label system (Issues #3083, #2069) that the
Traefik path doesn't have. The dedicated-Caddy split I previously
recommended is the right shape of solution to a problem that
vanishes when you use the platform's first-class citizen.

**Dev note:** The 6-conn-per-origin limit applies to HTTP/1.1
cleartext too. For local dev with multiple browser tabs and 3 SSE
channels each, the limit becomes noticeable. The fix: the existing
`docker/docker-compose.yml` already runs a Caddy container for
local dev - leave it in place for the `crm.local` and `api.crm.local`
hosts (with mkcert certs), and add a small Traefik container
(`traefik:v3` with Docker provider enabled) for the SSE host.
The `apps/realtime-sse` source code is unchanged; only the local
dev proxy story shifts.

### 5.2 Why a separate service (T-E2 implementation note, 2026-09-04)

`@nestjs/core@12.0.1`'s `@Sse()` decorator is broken for any
subscription chain that requires an `await` inside its factory - the
async-handler, sync-handler+defer, and raw-`@Res()` shapes all commit
the SSE headers and run the DB queries, but zero `data:` frames reach
the socket. `@fastify/sse@0.6.0` has the same shape of bug (verified
2026-09-04). The standalone bare-`node:http` service in
`apps/realtime-sse/` is the only path with empirical evidence behind
it: the working `/api/sse/ping` canary in the Nest app (plain
`interval()`, no async setup) flushed frames; the same canary shape
ported to fastify flushed frames; the real routes with async setup
silently swallowed frames in both. See skill
`~/.hermes/skills/devops/shadhil-crm-dev/references/ci-workflow-pitfalls.md`
Pitfall 9 for the full diagnostic record (13+ runs).

The standalone service:
- uses bare `node:http` (no framework SSE plugin) - zero new runtime deps
- implements the exact pattern the canary proved works: `res.writeHead(200, ...)` +
  `res.write(': stream-open\n\n')` synchronously, then `setInterval` drives writes
- shares `@shadhil/database` and `@shadhil/api-types` workspace packages
- owns only the SSE consumer side; the StreamTicket model + mint flow stay in
  the Nest app (which is where the JWT-auth and `withRlsContext` patterns already live)

### 5.3 StreamTicket (auth model)

The browser's `EventSource` cannot set `Authorization` headers (spec
limitation). The StreamTicket is the workaround: an unguessable cuid
that lives in the URL query string, bound to (user, channel),
single-use, expires in 5 minutes. Leaked tickets are worthless after
the 5-min TTL or the first connect - whichever comes first.

**Mint (Nest, JWT-auth):** `POST /api/realtime/ticket` with body
`{ channel: "notifications" | "audit" | "chat:<leadId>" }`. For
`chat:<leadId>`, the Nest service performs a lead-visibility check
inside `withRlsContext` - the same check the REST list uses
(owner / same-team / admin-or-owner). Returns `{ ticket, channel,
expiresAt }`.

**Consume (SSE service, ticket-only):** `GET /api/sse/<channel>?ticket=<cuid>`.
The SSE service authenticates the ticket (no JWT - the ticket IS the
auth), deletes the row, and opens the stream. Channel-mismatch
rejection (defends against a leaked notification ticket being replayed
on the audit channel).

### 5.4 Channel access rules

| Channel | Mint-time check | Stream-time filter |
|---|---|---|
| `notifications` | Always allowed (row userId = ticket userId) | All rows where `userId = ticket.userId` |
| `audit` | Always allowed | `userId = ticket.userId` for SALES_EXEC/TELECALLER/MANAGER; all rows for ADMIN/OWNER (seeAll) |
| `chat:<leadId>` | Nest `withRlsContext` lead-visibility check (the actor must be able to read the lead) | All `Message` rows where `leadId = <id>` (visibility enforced at mint) |

### 5.5 Last-Event-ID resume

Every event carries `id: <row-cuid>`. Clients reconnect with
`?lastEventId=<cuid>` (the SSE spec's `Last-Event-ID` header isn't
readable from `EventSource`, so we use the query string). The SSE
service resolves the cuid to the row's `createdAt` timestamp and
replays rows newer than that.

### 5.6 Client (web, BFF)

The browser calls `POST /api/bff/realtime/ticket` (BFF mints via the
JWT-authed backend), then opens `new EventSource('/api/sse/<path>?ticket=<cuid>')`.
The BFF route at `apps/web/src/app/api/sse/[...path]/route.ts` is a
streaming proxy: it verifies the better-auth session cookie (so
unauthenticated browsers can't open streams) and pipes the
`fetch('/api/sse/<path>', { origin: SSE_BACKEND_URL }).body` through
`new Response(upstream.body, { headers })`. Next.js 15+ streams this
without buffering. Path allowlist (only `ping | healthz | notifications
| audit | chat/<cuid>`) prevents open-proxy abuse.

### 5.7 Reconnect logic

Exponential backoff 1s → 2s → 4s → 8s → max 30s, re-minting the
ticket on each new connection (single-use tickets are consumed on
connect). UI shows a "Reconnecting..." pill during outage.

---

## 6. Auth Architecture (better-auth + JWT bridge)

Per DESIGN.md §8 and `better-auth-best-practices` skill.

**`apps/web/lib/auth.ts`:**

```typescript
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
import { organization } from 'better-auth/plugins/organization';
import { apiKey } from 'better-auth/plugins/api-key';
import { prisma } from '@shadhil/database';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({ jwt: { issuer: 'shadhil-crm' } }),
    admin(),
    // NOTE (eng review 2026-08-30, A4): organization() plugin DROPPED.
    // `Team` model (packages/database/prisma/schema.prisma) is the single
    // grouping concept. Adding organization() would create two overlapping
    // units (Team + Organization) with separate invitation flows. Manager
    // is just a User with role='manager' assigned to a Team.
    apiKey(),
  ],
  trustedOrigins: [
    'http://localhost:3000',
    'https://crm.shadhilbuilders.in',
    'http://localhost:8081', // Expo dev
  ],
  secret: process.env.BETTER_AUTH_SECRET!, // 32+ chars, from openssl rand -base64 32
  baseURL: process.env.BETTER_AUTH_URL,
});
```

**Catch-all route:** `apps/web/app/api/auth/[...all]/route.ts` per better-auth docs.

**Schema generation:** `npx @better-auth/cli@latest generate --output packages/database/prisma/schema.prisma` then `pnpm prisma migrate dev`.

**JWT bridge to NestJS:** Symmetric HS256 (v1). NestJS verifies with same secret using `jose`. Claims: `sub`, `role`, `teamId`, `iat`, `exp`. Postgres session vars set per request for RLS.

**Mobile (`@better-auth/expo`):**

```typescript
import { createAuthClient } from '@better-auth/expo';
import { expoSecureStore } from '@better-auth/expo/storage';

export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_API_URL,
  storage: expoSecureStore(), // Keychain on iOS, EncryptedSharedPreferences on Android
});
```

---

## 7. Database Schema (Prisma, 18 models)

Per DESIGN.md §7 and §8. Single `schema.prisma` in `packages/database/`, generated client shared.

**Models:**
1. `User` - better-auth managed (User, Session, Account, Verification under hood)
2. `Team` - group of telecallers + execs under a manager
3. `ManagerAssignmentRule` - auto-routing rule for new leads
4. `Project` - Shadhil Metro Heights + future projects
5. `Phase` - within a project (e.g. Phase 1, Phase 2)
6. `Unit` - villa/unit (BHK, facing, sqft, price, status)
7. `Lead` - the central entity, with state machine
8. `Activity` - timeline entry (call, note, status change)
9. `SiteVisit` - visit instance with outcomes
10. `Message` - chat message (inbound/outbound, WhatsApp/in-app)
11. `Booking` - unit hold → token → approval
12. `Reminder` - scheduled reminders (4 types)
13. `Notification` - in-app inbox
14. `PushSubscription` - push tokens per device
15. `PushNotification` - push delivery audit (status: PENDING / DELIVERED / FAILED)
16. `AuditLog` - every login, view, state transition
17. `Consent` - DPDP consent capture
18. `WebhookEvent` - incoming webhook dedupe
19. `ManagerAssignmentRule` - auto-routing rule for new leads

**NOTE (eng review 2026-08-30, C2):** `InAppNotification` model DROPPED. The §1 v3.0 design listed 19 models; only 18 are in the final schema. The in-app inbox uses `Notification` directly; `PushNotification` is reserved for delivery audit only. Do not reintroduce `InAppNotification`.

**Role model (A6 - single primary role per user, no v1 role switching):**

**RLS policies** (per DESIGN.md §8) - every business table has RLS keyed off `current_setting('app.user_id')` set by NestJS per request.

---

## 8. Notifications (12 triggers + 4 reminder types)

Per DESIGN.md §10 + §12.

**12 push triggers (staff-facing):**

| # | Trigger | Recipients |
|---|---|---|
| 1 | New lead assigned | Assigned telecaller |
| 2 | Lead handed off | Manager |
| 3 | Lead handed off (team) | All managers in team |
| 4 | Lead assigned (exec) | Assigned exec |
| 5 | Pre-visit staff T-2h | Sales exec |
| 6 | No-show staff T+2h | Sales exec + manager |
| 7 | Customer replied (staff away) | Lead owner |
| 8 | Booking awaiting approval | Manager |
| 9 | Booking approved/rejected | Sales exec |
| 10 | Customer rescheduled | Sales exec |
| 11 | Mentioned in note/chat | Mentioned user |
| 12 | Daily summary 8 AM (opt-in) | Manager + admin |

**4 reminder types:**
- `PRE_VISIT_STAFF` - T-2h before visit → sales exec → push + in-app + email fallback
- `PRE_VISIT_CUSTOMER` - T-24h + T-2h → customer → WhatsApp
- `RESCHEDULE_FOLLOWUP` - T+1h after reschedule → sales exec → push + in-app
- `NO_SHOW_STAFF` - T+2h after visit, no outcome logged → sales exec + manager → push + in-app; customer WhatsApp: `missed_visit_followup`

**Cron processor (eng review A3 - Redis-locked):**

```typescript
@Cron('* * * * *')
async processDueReminders() {
  // Acquire Redis lock; only the replica that gets it runs the cron.
  // Prevents duplicate reminders when NestJS scales to 2+ replicas.
  const lockKey = 'cron:reminders:lock';
  const lockTtl = 50; // seconds (cron fires every 60s)
  const acquired = await this.redis.set(lockKey, this.process.pid, 'EX', lockTtl, 'NX');
  if (!acquired) return; // another replica owns this tick

  try {
    const due = await this.prisma.reminder.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
      take: 100,
    });
    for (const reminder of due) {
      await this.fireReminder(reminder);
    }
  } finally {
    await this.redis.del(lockKey);
  }
}
```

---

## 9. Compliance (RERA TN + DPDP)

Per DESIGN.md §11 + §18.

**RERA TN Rules 2017:**
- RERA registration number on every customer-facing surface (WhatsApp templates, landing site, push titles) - mandatory, input from client (SIGN-OFF #1)
- Project-level data export on inspector demand - `GET /compliance/rera-export?projectId=...` → JSON dump
- Audit retention 7 years (RERA upper bound)

**DPDP Act 2023:**
- Consent capture on lead creation - `Consent` table with `consentType` (marketing, data_processing, communication), `grantedAt`, `ipAddress`
- Right-to-erasure workflow - Admin only, cascades all related data
- 30-day response window

**Audit log writer (every action - transactional, eng review A2):**

```typescript
// AuditInterceptor on every controller
// IMPORTANT: audit write MUST be in the same transaction as the action.
// If the audit write fails after the action succeeds, RERA compliance
// is broken (silent missing audit). Use prisma.$transaction.
async intercept(context: ExecutionContext, next: CallHandler) {
  const req = context.switchToHttp().getRequest();
  const result = await next.handle();

  // Use the request's transactional client if available (preferred),
  // otherwise fall back to a fresh transaction. The action handler should
  // have committed by this point, so we use a separate transaction and
  // accept the eventual-consistency window.
  await this.prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: req.method + ' ' + req.route.path,
        entityType: extractEntityType(req),
        entityId: extractEntityId(req),
        before: extractBeforeSnapshot(req),
        after: result,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });
  });

  return result;
}
```

**Alternative pattern (preferred for high-stakes actions):** action service accepts `tx` (transactional client), audit write happens inside the same `$transaction` block. No interceptor needed; audit is mandatory by construction.

---

## 10. Deployment Architecture (Coolify on Hostinger VPS)

Per DESIGN.md §6.

**Infrastructure:**
- **Hostinger VPS 8GB**, India region (Mumbai), ~₹2,500/month
- **Coolify** handles SSL (Let's Encrypt), backups (daily Postgres dump to Backblaze B2), deploys from Git
- **Docker Compose on VPS:** Next.js, NestJS, Postgres 16, PgBouncer, Redis 7, standalone SSE service (apps/realtime-sse)
- **Subdomains** (see §5.0 for the full rationale):
  - `crm.shadhilbuilders.in` - Next.js (apps/web) on port 3000
  - `api.crm.shadhilbuilders.in` - NestJS (apps/backend) on port 8080
  - `sse.crm.shadhilbuilders.in` - standalone SSE (apps/realtime-sse) on port 8090
- **Reverse proxy:** **Traefik** (Coolify's default; we don't change
  it). All three subdomains route through Coolify's built-in
  Traefik. The SSE service uses Docker labels to opt out of
  response compression on its routes (Traefik auto-detects
  streaming on `Content-Type: text/event-stream`, so no explicit
  `flushInterval` is needed). Full label config, dev-proxy story,
  and the compression pitfall are in
  `~/.hermes/skills/devops/shadhil-crm-dev/references/prod-deployment.md`
  (Traefik integration, observability, and performance sections).

**CI/CD:**
- GitHub Actions for tests + lint + type-check on every PR
- Coolify auto-deploys from `main` branch
- Manual approval for production releases

**Observability baseline (Week 13+):**
- Caddy JSON access logs piped to a rotating file (or Loki if you set
  it up)
- Alert on `5xx` for any path under `/api/sse/` - real incident
  because it means a client connection is dead
- Don't add Prometheus + Grafana until >500 concurrent SSE
  connections (the SSE service's own `/metrics` endpoint is a
  T-PERF-2 follow-up)

**Performance thresholds (Hostinger VPS 8GB / 4 vCPU):**
- <500 concurrent SSE: polling + current architecture is correct
- 500-2000: raise Prisma connection_limit, watch event-loop
- 2000-5000: migrate to Postgres LISTEN/NOTIFY (T-PERF-3)
- 5000+: load-balanced Node + Redis pub/sub (post-launch)

**Set `ulimit -n 65536`** on the SSE service container (the Docker
default 1024 will EMFILE at ~500 connections).

**Backups:**
- Daily Postgres dump → Backblaze B2 (encrypted)
- Weekly restore test (cron validates dump integrity)
- 7-year retention for call recordings + audit logs (Cloudflare R2)

**Monitoring:**
- Better Stack uptime monitoring (free tier)
- Sentry error tracking (free tier)
- Health check endpoint on both apps (every 30s)
- Alert via Telegram on outage

**Costs (recurring, 10 users):**
| Line item | Monthly |
|---|---|
| Hostinger VPS 8GB | ~₹2,500 |
| Backblaze B2 / Cloudflare R2 | ~₹500 |
| FreJun telephony | ~₹15,300 |
| Expo Push | Free |
| Better Stack | Free |
| Sentry | Free |
| **Total** | **~₹18,300/month** |

---

## 11. Open Items / Risks (per DESIGN.md §19)

Per DESIGN.md's own "push back" list, carried forward:

1. **Stack is NestJS + REST on self-hosted VPS.** Defensible but slower to ship than Supabase full-stack. Data model + auth design transfer with ~1 week rework if revisiting at Week 3.
2. **Coolify is real but Shadhil is on-call.** 4–8 hours/month for VPS maintenance, Postgres backup verification, Coolify upgrades. Confirm bandwidth with client.
3. **"1 ms literally" impossible.** Deliver 99.95% (52 min/year). Multi-region HA is v3 conversation.
4. **Model C requires Shadhil to enforce process.** Telecaller books + confirms, exec conducts visit, ownership transfers automatically. Without enforcement, no-show metric doesn't improve.
5. **No-show / reschedule / cold states + Reminders module are v1, not vNext.** #1 source of lead loss in Indian real estate CRMs.
6. **Customer-side pre-visit reminders in v1.** Industry data shows they halve no-show rate. 2 extra WhatsApp templates, large value.
7. **Notification preferences per trigger are v1.1.** Ship 12 on by default, "Mark all as read" for noise control.
8. **Daily summary push opt-in, default off.** Some managers love it, some find annoying.

---

## 12. Pre-Build Checklist (before Week 1 starts)

- [ ] **Client sign-off on SIGN-OFF-SUMMARY-v3.1.md** (signed by promoter + sales lead + finance lead)
- [ ] **6 inputs received:**
  1. RERA registration number for Metro Heights + CMDA plan approval number
  2. Signed process adoption of Model C (sales leadership signature)
  3. WhatsApp Business number provisioning confirmation
  4. FreJun sign-off (vendor contract or letter of intent)
  5. First manager + telecaller + sales exec roster (names, emails, phones)
  6. Sales exec + telecaller phone numbers for FreJun KYC
- [ ] **Hostinger VPS procured** + Coolify installed
- [ ] **Domain DNS** configured for both subdomains
- [ ] **GitHub repo** created: `github.com/paalstack/shadhil-crm` (private)
- [ ] **Apple Developer account** for iOS app submission (Week 10)
- [ ] **Google Play Developer account** for Android app submission (Week 10)

---

## 13. Success Metrics (DESIGN.md §13, Day 30/60/90 targets)

The build is "done" when these are measurable, not when the 13 weeks elapse.

| Metric | Day 30 | Day 60 | Day 90 |
|---|---|---|---|
| Time-to-first-touch (median) | <30 min | <20 min | <15 min |
| No-show rate | <30% | <25% | <20% |
| Handoff response latency (Model C exec response post-VISITED) | <30 min | <15 min | <10 min |
| Daily active agent use | ≥4/5 with ≥5 actions/day | ≥4/5 with ≥8 | ≥5/5 with ≥10 |
| Activity completeness (≥3 logged activities in first 7 days) | ≥60% | ≥80% | ≥90% |
| Reschedule follow-up compliance | ≥80% | ≥90% | ≥95% |

**Reporting:** Manager dashboard surfaces all 6 KPIs. Weekly Friday status email from PaalStack to Shadhil includes these numbers.

### 13.1 Technical SLOs (eng review P4, 2026-08-30)

The business KPIs in §13 measure outcomes. These are the technical budgets that ensure the system can deliver those outcomes.

| Metric | Target p50 | Target p95 | Target p99 | Notes |
|---|---|---|---|---|
| Lead Inbox first paint | <500ms | <1.5s | <3s | Cached after first load |
| Lead Inbox data fetch (TanStack Query) | <200ms | <500ms | <1s | Single Prisma query with include (P3) |
| Lead Detail tab switch | <100ms | <300ms | <500ms | Client-side, no refetch |
| Chat SSE event delivery (server publish → client render) | <500ms | <2s | <5s | After Redis publish + EventSource frame |
| Notification SSE event delivery | <1s | <3s | <8s | Lower priority than chat |
| Push notification (web + Expo) | <30s end-to-end | <60s | <120s | Expo Push receipt polling (5min) |
| RERA export (100k rows) | n/a | <30s | <60s | Postgres COPY + cursor pagination (P2) |
| Reassign POST round-trip | <300ms | <800ms | <2s | Includes permission check + DB write + notification fan-out |
| KPI dashboard initial render | <500ms | <1s | <2s | 4 KPI queries + Manager dashboard team view |
| SSE reconnect after disconnect | <5s | <15s | <30s | Exponential backoff (1s → 2s → 4s → 8s → max 30s) |
| Cron reminder pickup latency (scheduledFor → reminder fired) | <30s | <90s | <180s | Cron runs every minute; lock acquisition + worker time |

**Load test gates (eng review T1, P4):**
- `apps/backend/test/load/leads-inbox.k6.ts` - 50 concurrent users, Lead Inbox load. p95 < 500ms required.
- `apps/backend/test/load/sse-fanout.k6.ts` - 100 concurrent SSE connections on /notifications/stream. EventSource stability for 10 minutes required.
- `apps/backend/test/load/rera-export.k6.ts` - 100k-row export under 30s.

**k6 setup:** Install `k6` separately. Each test is a `*.k6.ts` file with a default export `options` and a `default function()`. Run via `k6 run apps/backend/test/load/leads-inbox.k6.ts`. Add to CI as a nightly job (not on every PR - too slow).

---

## 14. Skills Activated for This Build

Installed via `find-skills` methodology (verified install counts + source reputation):

| Skill | Installs | Use case |
|---|---|---|
| `better-auth-best-practices` | 102.2K | Auth setup, Prisma adapter, JWT plugin |
| `monorepo-management` | 12.7K | Workspace conventions, package boundaries |
| `tailwind-design-system` | 3.2K | Design tokens, theming infrastructure |
| `turborepo-monorepo` | 2.7K | turbo.json pipeline, CI integration |
| `react-native-dev` | 1.8K | Expo patterns, mobile architecture |
| `shadcn` (sickn33) | 166 | General shadcn/ui knowledge (component-lib underpinning) |
| `shadcn-component-discovery` (mattbx) | 582 | Find the right shadcn primitive quickly |

Inline-loaded via `npx skills use` (not installed - applied per request):

| Skill | Source | Use case |
|---|---|---|
| `expo-native-ui` | expo/skills (official) | `@expo/ui` native controls, SF Symbols, Color API, Reanimated |
| `expo-tailwind-setup` | expo/skills (official) | Tailwind v4 + react-native-css + NativeWind v5 in Expo |
| `vercel-react-native-skills` | vercel-labs/agent-skills (official) | RN/Expo performance, list virtualizer, animations, navigation |

Plus existing PaalStack skills (paalstack-react-ui, saas-mvp-architecture, etc.).

---

## 15. Mobile Performance Rules (Vercel RN - enforced per rule)

From `vercel-react-native-skills` (Vercel official). Every rule applies to Shadhil CRM mobile. Failure mode if ignored: jank, dropped frames, battery drain on field sales visits.

| Priority | Category | Rules applied to Shadhil |
|---|---|---|
| **CRITICAL** | List Performance | FlashList for Lead Inbox (estimatedItemSize: 80), Notification Center (120), Chat pane (88), Site Visit list (96), Manager's Team Pipeline (100). Memoize row components. Stable `useCallback` for renderItem/keyExtractor. No inline style objects. Functions extracted outside render. `expo-image` for any avatar/photo with `cachePolicy="memory-disk"`. |
| **HIGH** | Animation | Reanimated v4. Animate ONLY `transform` (translateX/Y/scale/rotate) and `opacity`. Never animate layout properties (width, height, top, left). Use `useDerivedValue` for computed animations. `Gesture.Tap` (not Pressable) for the new-visit-banner "On my way" toggle and chat message swipe-reply. |
| **HIGH** | Navigation | Native stack (`@react-navigation/native-stack` via expo-router default - NOT `@react-navigation/stack`). Native tabs (expo-router native tabs - NOT `@react-navigation/bottom-tabs`). |
| **HIGH** | UI Patterns | `expo-image` for ALL images (avatars, project photos, unit photos). `Pressable` for all touchable (NOT `TouchableOpacity`). Safe areas in ScrollViews via `contentInsetAdjustmentBehavior="automatic"`. `contentInset` for header offsets. Native context menus (long-press on lead row → Reassign/Mark contacted/etc). Native modals (manager booking approval). `onLayout` for measuring Lead Detail tabs (NOT `measure()`). StyleSheet.create or NativeWind - inline styles discouraged. |
| **MEDIUM** | State | Minimize state subscriptions (selector slices per screen). Dispatcher pattern for callbacks (avoid re-render cascade). Show fallback on first render (skeleton, not blank). Destructure functions for React Compiler. |
| **MEDIUM** | Rendering | Wrap text in `<Text>` always (NOT `<View>{name}</View>`). Never `cond && <X/>` - use `cond ? <X/> : null`. |
| **MEDIUM** | Monorepo | Native deps stay in app package (`apps/mobile/node_modules/...`), not hoisted to root. Single dependency versions across workspace (Turborepo `transit` task enforces). |
| **LOW** | Configuration | Custom fonts via Expo config plugin. Design system imports organized (`@/tw` for wrapped primitives). Hoist `Intl.DateTimeFormat` outside render for chat timestamps. |

---

## 16. Document Map

| Doc | Purpose |
|---|---|
| `DESIGN.md` | Source design brief (1,038 lines, scope, architecture, lifecycle) |
| `SIGN-OFF-SUMMARY-v3.1.md` | 1-page executive summary for client sign-off |
| `IMPLEMENTATION-PLAN-v1.md` | **THIS FILE** - full build plan |
| `6-INPUTS-REQUEST-TO-CLIENT.md` | **NEW** - tracker for the 6 client inputs (status + placeholders + escalation) |
| `WORKFLOW-DIAGRAMS.md` | 6 ELI10 diagrams (system, web auth, mobile auth, lifecycle, handoff) |
| `CLIENT-DECISIONS.md` | 16 resolved client questions + reliability design |
| `DECISION-CHANGELOG.md` | Every decision round in order |
| `CLIENT-FEEDBACK-v1..v12` | Reasoning trail per round |

---

## 17.6-Inputs Implementation Wiring

This section locks the **integration code structure** for each of the 6 client inputs. Code is built and unit-tested with placeholders; real values are swapped in when client delivers them (no rebuild needed). Tracker doc: `6-INPUTS-REQUEST-TO-CLIENT.md`.

### Input #1 - RERA + CMDA registration

**Single source of truth:** `packages/ui-tokens/compliance.ts`

```typescript
// packages/ui-tokens/compliance.ts
// ONE file. All RERA + CMDA references flow from here.
// Updated when client sends the real certificate.

export const COMPLIANCE = {
  projectName: 'Shadhil Metro Heights',
  rera: {
    registrationNumber: process.env.NEXT_PUBLIC_RERA_NUMBER ?? 'TN/02/0000/2024',
    // ↑ placeholder; replaced when client's real cert arrives
    validFrom: process.env.NEXT_PUBLIC_RERA_VALID_FROM ?? '2024-01-01',
    validUntil: process.env.NEXT_PUBLIC_RERA_VALID_UNTIL ?? '2029-01-01',
  },
  cmda: {
    planApprovalNumber: process.env.NEXT_PUBLIC_CMDA_NUMBER ?? 'CMDA-PENDING',
    validFrom: process.env.NEXT_PUBLIC_CMDA_VALID_FROM ?? '2024-01-01',
    validUntil: process.env.NEXT_PUBLIC_CMDA_VALID_UNTIL ?? '2029-01-01',
  },
} as const;

// Formatters used across the app
export function reraFooterLine(): string {
  return `RERA: ${COMPLIANCE.rera.registrationNumber} | CMDA: ${COMPLIANCE.cmda.planApprovalNumber}`;
}

export function whatsappTemplateHeader(): string {
  return `${COMPLIANCE.projectName} (RERA: ${COMPLIANCE.rera.registrationNumber})`;
}
```

**Surfaces (auto-updates when env vars change):**
- WhatsApp template headers (4 templates) - `apps/backend/src/whatsapp/templates.ts` calls `whatsappTemplateHeader()`
- Landing site footer - `~/workspace/shadhil-projects/landing-page/` (verify, may already exist)
- Push notification titles - `apps/backend/src/notifications/triggers.ts` prepends RERA#
- RERA compliance export - `apps/backend/src/compliance/rera-export.controller.ts` includes RERA# per record
- Login page footer - `apps/web/src/app/(auth)/login/page.tsx`

**Verification (with placeholder):**
- `pnpm test compliance` - assertion that all 4 surfaces show the placeholder RERA#
- When client sends real value: set `NEXT_PUBLIC_RERA_NUMBER` env in Coolify, redeploy, no code change

**Escalation:** PaalStack flags in weekly Friday status if Input #1 is missing by EOD Wednesday of Week 1.

---

### Input #2 - Signed Model C process adoption

**Feature flag:** `MODEL_C_ENABLED` env var (default `false` until signature lands)

```typescript
// apps/web/lib/feature-flags.ts
export const FEATURE_FLAGS = {
  MODEL_C_ENABLED: process.env.NEXT_PUBLIC_MODEL_C_ENABLED === 'true',
} as const;

// apps/backend/src/leads/lead-state-machine.ts
export function transitionLead(ctx: TransitionContext): LeadState {
  if (!FEATURE_FLAGS.MODEL_C_ENABLED) {
    // Legacy "always-telecaller" model: ownership never transfers
    // Used during the gap between scaffold and signature landing
    return legacyTransition(ctx);
  }
  return modelCTransition(ctx); // §3 state machine above
}
```

**Workflow:**
1. **Before signature:** Scaffold + state machine built but legacy mode. Visits log normally, ownership stays with telecaller regardless of outcome. No model C handoff toast, no exec transfer.
2. **After signature:** Flip `MODEL_C_ENABLED=true` env in Coolify + redeploy. State machine switches to Model C behavior. No data migration needed (ownership column stays consistent because legacy model never transferred ownership).

**Verification:**
- Without flag: visit outcome logs to audit but owner unchanged
- With flag: visit outcome triggers handoff + toast + bell notification (per Decision 0.8)

**Escalation:** PaalStack flags if Input #2 is missing by EOD Wednesday of Week 2 (need flag flipped before Week 4 Lead Detail build).

---

### Input #3 - WhatsApp Business number

**Env vars:** `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `WA_WEBHOOK_VERIFY_TOKEN`

```typescript
// apps/backend/src/whatsapp/whatsapp.config.ts
export const WHATSAPP_CONFIG = {
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID ?? 'PLACEHOLDER_PENDING_CLIENT',
  businessAccountId: process.env.WA_BUSINESS_ACCOUNT_ID ?? 'PLACEHOLDER_PENDING_CLIENT',
  accessToken: process.env.WA_ACCESS_TOKEN ?? '', // empty = disabled
  webhookVerifyToken: process.env.WA_WEBHOOK_VERIFY_TOKEN ?? '',
  apiBaseUrl: 'https://graph.facebook.com/v21.0',
} as const;

// Guard: refuse to send if not configured
export function assertWhatsAppConfigured(): void {
  if (!WHATSAPP_CONFIG.accessToken) {
    throw new WhatsAppNotConfiguredError(
      'WhatsApp Business number not provisioned. See 6-INPUTS-REQUEST-TO-CLIENT.md#input-3'
    );
  }
}
```

**Code paths:**
- `apps/backend/src/whatsapp/send-message.use-case.ts` calls `assertWhatsAppConfigured()` before any API call
- `apps/backend/src/whatsapp/webhook.controller.ts` returns 503 if `WHATSAPP_CONFIG.webhookVerifyToken` is empty (Meta rejects unverified webhooks anyway, but fail fast is better)
- `apps/backend/src/webhooks/webhook-event.processor.ts` queues inbound messages in Redis even if number is not provisioned; processes when configured

**4 WhatsApp templates (Meta submission Week 1):**
- `visit_reminder_24h` - pre-visit customer reminder
- `visit_reminder_2h` - pre-visit customer reminder
- `missed_visit_followup` - no-show follow-up
- `customer_enquiry_confirmation` - initial lead response

**Verification:**
- Without config: send returns graceful error, message queued, retry on next send attempt
- With config: messages deliver to customer phone within 5s

**Escalation:** PaalStack flags if Input #3 missing by EOD Wednesday of Week 4 (need number active by Week 5 start for template testing).

---

### Input #4 - FreJun vendor sign-off

**Env vars:** `FREJUN_API_KEY`, `FREJUN_WEBHOOK_SECRET`, `FREJUN_AGENT_NUMBER`

```typescript
// apps/backend/src/telephony/frejun.config.ts
export const FREJUN_CONFIG = {
  apiKey: process.env.FREJUN_API_KEY ?? '',
  webhookSecret: process.env.FREJUN_WEBHOOK_SECRET ?? '',
  agentNumber: process.env.FREJUN_AGENT_NUMBER ?? '+910000000000',
  apiBaseUrl: 'https://api.frejun.com/v1',
} as const;

export function assertFrejunConfigured(): void {
  if (!FREJUN_CONFIG.apiKey) {
    throw new TelephonyNotConfiguredError(
      'FreJun contract not active. See 6-INPUTS-REQUEST-TO-CLIENT.md#input-4'
    );
  }
}
```

**Code paths:**
- `apps/backend/src/telephony/incoming-call.webhook.ts` - handles FreJun webhooks for incoming calls
- `apps/backend/src/telephony/call-recording.archiver.ts` - uploads recordings to Cloudflare R2
- `apps/backend/src/telephony/agent-provisioning.script.ts` - runs once FreJun is configured to provision the 10 agents

**Verification:**
- Without config: incoming webhook returns 503, no calls logged
- With config: incoming call → recording saved to R2 within 60s + AI transcription appears in lead timeline

**Escalation:** PaalStack flags if Input #4 missing by EOD Wednesday of Week 4 (need contract active by Week 5 telephony build).

---

### Input #5 - First roster

**Bootstrap mechanism:** Better-auth admin plugin + seed script

```typescript
// apps/backend/prisma/seed.ts
// Runs once on first deploy (or via `pnpm seed`)
// Uses env vars for first 3 users; later roster comes from Admin UI

import { auth } from '@shadhil/auth';

async function seedFirstUsers() {
  const firstAdmin = {
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@shadhilbuilders.in',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'CHANGE_ME_ON_FIRST_LOGIN',
    name: process.env.SEED_ADMIN_NAME ?? 'Shadhil Admin',
    role: 'admin' as const,
  };

  const firstManager = {
    email: process.env.SEED_MANAGER_EMAIL ?? 'manager@shadhilbuilders.in',
    password: process.env.SEED_MANAGER_PASSWORD ?? 'CHANGE_ME_ON_FIRST_LOGIN',
    name: process.env.SEED_MANAGER_NAME ?? 'First Manager',
    role: 'manager' as const,
    teamName: 'Default Team',
  };

  const firstTelecaller = {
    email: process.env.SEED_TELECALLER_EMAIL ?? 'telecaller@shadhilbuilders.in',
    password: process.env.SEED_TELECALLER_PASSWORD ?? 'CHANGE_ME_ON_FIRST_LOGIN',
    name: process.env.SEED_TELECALLER_NAME ?? 'First Telecaller',
    role: 'telecaller' as const,
    teamName: 'Default Team',
  };

  for (const user of [firstAdmin, firstManager, firstTelecaller]) {
    await auth.api.signUpEmail({ body: user });
  }
}
```

**Workflow:**
1. **Before roster:** Seed script runs with placeholder emails (`admin@shadhilbuilders.in`, etc.) + `CHANGE_ME_ON_FIRST_LOGIN` passwords. Admin gets a magic link to set a real password.
2. **After roster arrives:** Update env vars in Coolify with real names/emails → run `pnpm seed` → 3 real users created. If seed already ran with placeholders, run a one-time migration script to update User table.
3. **Roster additions after go-live:** Admin uses the Admin UI to add/remove users. Better-auth admin plugin handles this in-app.

**Verification:**
- Without roster: 3 placeholder users created, Admin can sign in via magic link
- With roster: 3 real users, Admin invites Manager/Telecaller by email from Admin UI

**Escalation:** PaalStack flags if Input #5 missing by EOD Wednesday of Week 2 (need 3 users by end of Week 3).

---

### Input #6 - Sales exec + telecaller phone numbers for FreJun KYC

**Linked to Input #5:** Phone numbers are part of the user record (User table has `phone` column for SMS + telephony).

```typescript
// apps/backend/prisma/schema.prisma (already in §7)
// User model has phone field:
//   phone String? @unique
// FreJun KYC script reads from User table

// apps/backend/src/telephony/frejun-kyc.script.ts
// Runs after Input #5 + Input #6 land
// Reads all User.records where role in [sales_executive, telecaller]
// Calls FreJun API to provision each agent

export async function provisionFrejunAgents() {
  const staff = await prisma.user.findMany({
    where: { role: { in: ['sales_executive', 'telecaller'] } },
    select: { id: true, name: true, email: true, phone: true },
  });

  if (staff.some(s => !s.phone)) {
    throw new Error(
      'Missing phone numbers for some staff. See 6-INPUTS-REQUEST-TO-CLIENT.md#input-6'
    );
  }

  // Per-agent try/catch (eng review A7) - one failure must not block the rest.
  const results: { userId: string; status: 'created' | 'failed'; error?: string }[] = [];
  for (const user of staff) {
    try {
      await frejunApi.createAgent({
        name: user.name,
        email: user.email,
        phone: user.phone!,
      });
      results.push({ userId: user.id, status: 'created' });
    } catch (err) {
      this.logger.error({ err, userId: user.id }, 'FreJun agent provisioning failed');
      results.push({ userId: user.id, status: 'failed', error: err.message });
    }
  }
  return {
    created: results.filter(r => r.status === 'created').length,
    failed: results.filter(r => r.status === 'failed'),
  };
}
```

**Workflow:**
1. **Before numbers:** FreJun KYC script refuses to run if any user has `phone = null`. UI shows "phone required for telephony" in Admin → User Management.
3. **After numbers:** Admin updates phone numbers in Admin UI → runs `pnpm frejun:provision` → FreJun agents created.

**Verification:**
- Without numbers: Admin UI shows red badge "Phone required for telephony"
- With numbers: FreJun dashboard shows N agents provisioned, each with assigned Shadhil number

**Escalation:** PaalStack flags if Input #6 missing by EOD Wednesday of Week 4 (need numbers live by Week 5 telephony integration).

---

### Master check: 6 inputs → env vars → code readiness

| Input | Env vars added | Code path | Test with placeholder | Test with real value |
|---|---|---|---|---|
| #1 RERA + CMDA | `NEXT_PUBLIC_RERA_NUMBER`, `NEXT_PUBLIC_CMDA_NUMBER`, `*_VALID_FROM`, `*_VALID_UNTIL` | `packages/ui-tokens/compliance.ts` (1 file) | ✅ All 4 surfaces show placeholder | ✅ Just update env + redeploy |
| #2 Model C signature | `NEXT_PUBLIC_MODEL_C_ENABLED` | `apps/backend/src/leads/lead-state-machine.ts` (1 flag) | ✅ Legacy mode, ownership stable | ✅ Flip flag, no data migration |
| #3 WhatsApp # | `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `WA_WEBHOOK_VERIFY_TOKEN` | `apps/backend/src/whatsapp/whatsapp.config.ts` (1 file) | ✅ Send returns graceful error | ✅ Set env + 4 templates work |
| #4 FreJun contract | `FREJUN_API_KEY`, `FREJUN_WEBHOOK_SECRET`, `FREJUN_AGENT_NUMBER` | `apps/backend/src/telephony/frejun.config.ts` (1 file) | ✅ Webhook returns 503 | ✅ Set env + calls work |
| #5 Roster | `SEED_*_EMAIL`, `SEED_*_NAME`, `SEED_*_PASSWORD` | `apps/backend/prisma/seed.ts` (1 script) | ✅ 3 placeholder users | ✅ Set env + re-run seed |
| #6 Phone numbers | (No env; comes from User.phone column) | `apps/backend/src/telephony/frejun-kyc.script.ts` (1 script) | ✅ Admin UI shows "phone required" badge | ✅ Run script after users have phone |

**Total: 6 small env-var additions, no schema changes, no migrations. Code is built and unit-tested in Week 1–2 with placeholders. Real values drop in via Coolify env config - no rebuild.**

---

## 18. Manual Lead Assignment (Admin/Manager)

**Source request (2026-08-30):** "admin/manager assign the lead to sales or telecaller; admin can access all the resources"
**Decisions locked:** Admin = full cross-team read; manual reassign = cross-role allowed; manual reassign = bypasses `ManagerAssignmentRule` (rule fires only on NEW leads).
**Affects:** §1 (roles), §3 (state machine), §7 (RLS), §8 (auth/permissions); DESIGN.md §1 (role table), §3 (handoff).
**Tracker doc:** `ASSIGNMENT-MODEL-CHANGE.md` (full design rationale + matrix + edge cases)

### Updated role permissions (vs DESIGN.md §1)

| Role | Can now do | Still cannot |
|---|---|---|
| **Admin** | **Reassign any lead to any Telecaller or any Sales Exec** (system-wide); **read every lead across all teams** | Self-claim ownership without also holding Telecaller/Sales Exec role |
| **Manager** | **Reassign any lead in their team** to any Telecaller or any Sales Exec in their team (cross-role allowed) | Reassign leads across teams; see other managers' teams |
| **Telecaller** | (unchanged) | Reassign leads |
| **Sales Executive** | (unchanged) | Reassign leads |

### RLS policy additions (Postgres)

Add 4 new policies on the `Lead` table (existing policies from §7 stay):

```sql
-- Admin reads every lead
CREATE POLICY lead_select_admin ON "Lead"
  FOR SELECT USING (current_setting('app.user_role') = 'admin');

-- Admin updates any lead (including owner_id)
CREATE POLICY lead_update_admin ON "Lead"
  FOR UPDATE USING (current_setting('app.user_role') = 'admin');

-- Manager updates leads in their team (including owner_id, team-scoped)
CREATE POLICY lead_update_manager ON "Lead"
  FOR UPDATE USING (
    current_setting('app.user_role') = 'manager'
    AND "teamId" = current_setting('app.user_team_id')
  );

-- Manager reads leads in their team (already exists, no change needed)
```

Validation layer in NestJS (in addition to RLS):

```typescript
// apps/backend/src/leads/reassign.guard.ts
async canReassign(actor: JwtPayload, lead: Lead, target: User): Promise<boolean> {
  if (actor.role === 'admin') return true; // Admin can do anything
  if (actor.role === 'manager' && actor.teamId === target.teamId) return true;
  return false; // Telecaller, Sales Exec, cross-team Manager - all denied
}
```

### New API endpoint

```typescript
// apps/backend/src/leads/reassign.controller.ts
@Post(':id/reassign')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'manager')
async reassign(
  @Param('id') leadId: string,
  @Body() body: { targetUserId: string; reason: string },
  @CurrentUser() actor: JwtPayload,
): Promise<Lead> {
  // 1. Fetch lead + target user
  const lead = await this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const target = await this.prisma.user.findUniqueOrThrow({ where: { id: body.targetUserId } });

  // 2. Permission check (RLS already restricts rows; this adds row-level guard)
  if (!(await this.reassignGuard.canReassign(actor, lead, target))) {
    throw new ForbiddenException('Manager can only reassign within their team');
  }

  // 3. Update lead ownership
  const before = { ownerId: lead.ownerId, ownerType: lead.ownerType };
  const updated = await this.prisma.lead.update({
    where: { id: leadId },
    data: { ownerId: target.id, ownerType: target.role },
  });

  // 4. Cancel old owner's reminders, create new owner's reminders
  await this.reminderService.reassignReminders(leadId, lead.ownerId, target.id);

  // 5. Audit log entry
  await this.auditLog.write({
    userId: actor.sub,
    action: 'LEAD_REASSIGNED',
    entityType: 'Lead',
    entityId: leadId,
    before,
    after: { ownerId: target.id, ownerType: target.role },
    reason: body.reason,
  });

  // 6. Notification triggers #13 + #14
  await this.notificationService.fire('LEAD_REASSIGNED', {
    leadId, oldOwnerId: lead.ownerId, newOwnerId: target.id, actorId: actor.sub, reason: body.reason,
  });

  // 7. SSE publish on both owners' notification channels
  await this.ssePublisher.publish(`user:${target.id}:notifications`, { type: 'LEAD_REASSIGNED', leadId });
  await this.ssePublisher.publish(`user:${lead.ownerId}:notifications`, { type: 'LEAD_REASSIGNED', leadId });

  return updated;
}
```

### Notification triggers added

**Trigger #13 - Lead manually reassigned:**

| Recipient | Title | Body |
|---|---|---|
| New owner | "Lead assigned to you" | "{{lead.name}} was assigned to you by {{assigner.name}}. Reason: {{reason}}" |
| Old owner | "Lead reassigned" | "{{lead.name}} was reassigned from you to {{newOwner.name}}" |
| Manager (if reassigner is Admin) | "Lead reassigned by Admin" | "Admin {{name}} reassigned {{lead.name}} to {{newOwner.name}}" |

**Trigger #14 - Cross-team reassign attempted + denied (security audit):**

| Recipient | Title | Body |
|---|---|---|
| Admin | "Reassign denied" | "Manager {{name}} tried to reassign {{lead.name}} across teams (target: {{newOwner.teamName}}). Blocked." |

### UI - Lead Inbox (web)

For Admin/Manager only - new "Reassign" bulk action + per-row action. UI sketch:

```
┌──────────────────────────────────────────────────────────────┐
│ Lead Inbox                            [+ New] [Bulk ▼] [⋯]   │
├──────────────────────────────────────────────────────────────┤
│ ☐ Name         Status    Source   Last activity     Owner    │
│ ☐ Rajesh K.    NEW       Google   2m ago           Asha T   │
│ ☐ Priya M.     CONTACTED Meta     5m ago           Vikram E  │
│                                                              │
│ [Bulk ▼] → Reassign...                                       │
└──────────────────────────────────────────────────────────────┘
```

**Reassign dialog** (web - uses Sheet from `@paalstack/react-ui`):

```
┌─────────────────────────────────────────┐
│ Reassign lead                           │
├─────────────────────────────────────────┤
│ Lead: Rajesh K. (NEW)                   │
│ Current owner: Asha T. (Telecaller)     │
│                                         │
│ Reassign to:                            │
│ ○ Telecaller: [Asha T. ▼]               │
│   → filtered to Admin: all teams;       │
│     Manager: own team only              │
│ ○ Sales exec: [Vikram E. ▼]             │
│                                         │
│ Reason (required):                      │
│ ┌─────────────────────────────────────┐ │
│ │ Sales exec requested handoff early  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]            [Reassign lead]     │
└─────────────────────────────────────────┘
```

### UI - Mobile (Lead Detail)

Native context menu on long-press (per Vercel RN skill §15):

- "Reassign..." (Admin/Manager only - hidden for Telecaller/Sales Exec)
- Opens native modal with same fields as web
- Uses `useFunctionalVariable` for color theming per `expo-native-ui` skill

### UI - Admin Dashboard (new)

Cross-team view for Admin:

```
┌────────────────────────────────────────────────────────────┐
│ Admin Dashboard                                            │
├────────────────────────────────────────────────────────────┤
│ Team Lead Counts:                                          │
│   Sales Team A: 47 leads (12 NEW, 8 VISIT_SCHEDULED)       │
│   Sales Team B: 38 leads (9 NEW, 5 VISIT_SCHEDULED)        │
│                                                            │
│ [View all leads →]  [Audit log →]  [Users →]               │
└────────────────────────────────────────────────────────────┘
```

Uses the same KPI strip pattern as Manager dashboard (per Decision 0.4). For Admin, the 4 KPIs become:
1. Total leads across all teams
2. Reassignments in last 7 days (sanity check on team health)
3. Audit log entries in last 24h (security pulse)
4. Users by role (Admin / Manager / Telecaller / Sales Exec)

### State machine interaction

Manual reassign is **independent** of Model C handoff:

- **Model C handoff** (auto, on visit outcome): ownership transfers per §3 state machine; coOwnerId may set; handoff toast fires.
- **Manual reassign** (Admin/Manager action): ownership transfers immediately; bypasses ManagerAssignmentRule; reassign toast fires.

If a lead is manually reassigned to a Sales Exec while in NEW state, Model C handoff still fires when the visit happens (state machine doesn't care who set the owner).

**Model C exception (ratified at /autoplan gate 2026-08-31, decision A):** Manual reassign of a NEW lead to a Sales Exec is an **explicit, intentional exception** to the §3 ownership invariant (NEW...VISIT_SCHEDULED = Telecaller owns). It is allowed because Admin/Manager judgment overrides the default routing; the invariant is respected everywhere else. Requirements: (1) the reassign audit event carries `exception: 'NEW_TO_EXEC'` when `fromState === 'NEW'` and target is SALES_EXEC; (2) `canTransition` is NOT widened - only the reassign path may set this ownership; (3) `lead-state-machine.test.ts` gets a case asserting manual NEW→SALES_EXEC succeeds via the endpoint and fails via a direct state transition attempt.

### `ManagerAssignmentRule` interaction

**Assignment model - BOTH modes coexist (user direction 2026-08-31, ratified):**

1. **Automatic assignment ("based on situation")** - every NEW lead is routed by the `ManagerAssignmentRule` engine at creation. Rules evaluate in priority order (lowest `rule.priority` value first); first match wins.
   - **Match criteria (any combination):** lead `source` (exact), `projectId`/`phaseId`, `language`, `region` - a rule with no criteria is a catch-all.
   - **Action:** assign to the rule's target user (must be TELECALLER or SALES_EXEC; ADMIN/MANAGER are rejected as targets).
   - **No-match fallback:** team's `defaultAssigneeId` (set by manager in Admin UI). If that's also unset, the lead stays NEW with `ownerId=null` and notification trigger #1 goes to the team manager for manual pickup.
   - **Where it runs:** synchronously inside lead-create in `apps/backend/src/leads/leads.service.ts` (Week 4 build window, +3h human / +30min CC - inside the existing phase).
   - **Ownership after creation:** the engine never re-runs on the same lead. Later ownership changes come only from Model C handoff (auto) or manual reassign (admin/manager).
2. **Manual reassign** - Admin/Manager actions per §18 above; overrides any rule's prior result. Manual reassign bypasses the rule engine entirely.

**Tests required (Week 4):** rule priority order; criteria combinations; catch-all; no-match → fallback → unassigned+manager-notified chain; ADMIN-target rejection; manual reassign after auto-assign.

Per D3: manual reassign bypasses the rule. Rule fires only on NEW leads. Rationale: Manager manually picking Exec X for a relationship reason must not be overridden by the rule.

### Audit log entry (mandatory)

```typescript
{
  userId: adminOrManagerId,
  action: 'LEAD_REASSIGNED',
  entityType: 'Lead',
  entityId: leadId,
  before: { ownerId: oldOwnerId, ownerType: oldOwnerType },
  after: { ownerId: newOwnerId, ownerType: newOwnerType },
  reason: string, // REQUIRED - UI enforces non-empty
  ipAddress: string,
  userAgent: string,
  timestamp: Date,
}
```

Retention: 7 years (RERA upper bound - matches existing audit retention from §9).

### Build impact (timeline)

| Task | Effort (human / CC) | Week |
|---|---|---|
| Update Lead RLS policies (add admin + manager reassign policies) | 2h / 15min | Week 4 |
| Add `POST /leads/:id/reassign` endpoint + guard | 3h / 30min | Week 4 |
| Add audit log entry type `LEAD_REASSIGNED` | 30min / 5min | Week 4 |
| Add notification triggers #13 + #14 | 1h / 15min | Week 7 |
| Add "Reassign" UI in Lead Inbox (web - Sheet + form) | 4h / 1h | Week 4 |
| Add "Reassign" context menu in Lead Detail (web - DropdownMenu) | 2h / 30min | Week 4 |
| Add "Reassign" native modal in mobile (per `expo-native-ui` skill) | 3h / 1h | Week 10 |
| Admin Dashboard (cross-team view, 4 KPIs) | 6h / 2h | Week 9 |
| Permission tests (Manager cannot cross teams, Telecaller cannot reassign, etc.) | 2h / 30min | Week 4 |
| **Total** | **23.5h human / 5h CC** | spread Weeks 4-10 |

**Net change to 13-week timeline:** **+0 weeks.** All work fits within existing Week 4 (Lead Inbox/Detail) and Week 9 (Manager dashboard) build windows. Mobile work folds into Week 10.

### Out of scope (still deferred)

- **Bulk reassign with auto-rule application** - defer to v1.1
- **Auto-rebalance** when Telecaller is overloaded - defer to v1.1
- **Lead sharing** (multiple owners outside Model C) - defer to v1.1
- **Manager override of Admin reassign** - N/A (Admin is top of chain)

---

## 19. Test Plan (eng review T1+T2, 2026-08-30 - complete test pyramid)

Test framework: **Vitest** for unit + integration, **Playwright** for web E2E, **Maestro** for mobile E2E. `paalstack-nextjs-starter` ships Vitest + Playwright configs; reuse them.

### 19.1 Unit tests (Vitest) - per-module

Per AGENTS.md, every module has `implementation.ts` + `index.ts` + matching `*.test.ts` co-located. Mandatory test files:

| Module | Test file | Coverage target |
|---|---|---|
| State machine | `apps/backend/src/leads/lead-state-machine.test.ts` | 100% (each transition + each role × state combination) |
| Permission guard | `apps/backend/src/leads/reassign.guard.test.ts` | 100% (admin/manager/telecaller/sales-exec × within-team/cross-team/within-role/cross-role) |
| Reassign controller | `apps/backend/src/leads/reassign.controller.test.ts` | 95% (happy + audit + notif + reminder reassign path) |
| SSE controllers | `apps/backend/src/realtime/*.test.ts` | 95% (auth + replay + Redis publish) |
| Reminder processor | `apps/backend/src/reminders/processor.test.ts` | 95% (cron tick + Redis lock + happy + partial failure) |
| Audit interceptor | `apps/backend/src/audit/interceptor.test.ts` | 100% (action in/out, audit row written, failure rolls back) |
| RERA export | `apps/backend/src/compliance/rera-export.test.ts` | 95% (RERA# included per record, 100k-row generation under 30s) |
| FreJun KYC | `apps/backend/src/telephony/frejun-kyc.test.ts` | 100% (all succeed, one fails, all fail, no phones) |
| Better-auth config | `packages/auth/auth.test.ts` | 90% (sign-up, sign-in, JWT issuance, admin role gating) |
| Compliance export | `packages/ui-tokens/compliance.test.ts` | 100% (all 4 surfaces show RERA#) |
| Feature flags | `apps/web/lib/feature-flags.test.ts` | 100% (MODEL_C_ENABLED true/false) |
| Lead Inbox hooks | `apps/web/src/features/leads/hooks/*.test.tsx` | 90% (useLeads query states, optimistic update rollback) |
| Lead Detail tabs | `apps/web/src/features/leads/detail/tabs/*.test.tsx` | 85% (renders, state transitions) |
| Chat pane | `apps/web/src/features/chat/*.test.tsx` | 85% (Send → optimistic → SSE confirm → read receipt) |
| Mobile Lead Inbox | `apps/mobile/src/features/leads/inbox/*.test.tsx` | 85% (FlashList render, item memoization, FlashList callback stability) |
| Mobile Chat pane | `apps/mobile/src/features/chat/*.test.tsx` | 80% (FlashList virtualized messages) |

**Test quality rubric:** ★★★ = behavior + edges + errors; ★★ = happy path; ★ = smoke. Aim for ★★★ across business logic (state machine, permissions, audit, reassign) and ★★ across UI components.

### 19.2 RLS isolation test matrix (security-critical, must pass)

`apps/backend/test/integration/rls-isolation.test.ts` - runs every (role × table × action) tuple. PostgreSQL session vars set per test via `SET LOCAL app.user_id = ...; SET LOCAL app.user_role = ...; SET LOCAL app.user_team_id = ...;`.

For each business table (Lead, SiteVisit, Booking, Message, Reminder, Notification, AuditLog):
- 4 roles × SELECT/INSERT/UPDATE/DELETE = 16 cases per table
- 8 tables × 16 = 128 cases minimum
- Expected: SELECT and UPDATE return only rows the role owns (or all rows for Admin per A1)
- Negative tests: Telecaller cannot SELECT another telecaller's leads; Manager cannot UPDATE across teams; Admin bypasses team scope (per A1, A4)

**Coverage requirement:** 100% of role × table × action combinations. Failure of any case = CI red.

### 19.3 Integration tests (Vitest + real NestJS app)

| Test | What it proves |
|---|---|
| `apps/backend/test/integration/auth-jwt.test.ts` | Sign in → JWT issued → REST call with Bearer → NestJS verifies → Postgres session vars set → RLS filters |
| `apps/backend/test/integration/lead-handoff.test.ts` | Lead VISITED → ownership transfers to assigned exec → audit row written → notification fired → SSE published |
| `apps/backend/test/integration/reassign.test.ts` | Admin reassigns lead cross-team → both owners see notification → audit log entry with reason |
| `apps/backend/test/integration/sse-resume.test.ts` | Client subscribes → message published → client disconnects → reconnects with Last-Event-ID → receives missed message |
| `apps/backend/test/integration/whatsapp-inbound.test.ts` | Meta webhook arrives → message created in DB → SSE broadcast → audit row written |
| `apps/backend/test/integration/frejun-incoming.test.ts` | FreJun webhook arrives → call logged → recording uploaded to R2 → AI transcription queued |

### 19.4 E2E tests (Playwright web, 1 per module)

| Module | Test path | What it walks |
|---|---|---|
| Auth | `apps/web/e2e/auth.spec.ts` | Login → JWT → landing page → logout |
| Lead Inbox | `apps/web/e2e/leads/inbox.spec.ts` | Login → Lead Inbox renders → filter by status → bulk reassign (Admin) → toast appears |
| Lead Detail | `apps/web/e2e/leads/detail.spec.ts` | Open lead → all 6 tabs render → send chat message → Message appears in timeline |
| Site Visit Scheduler | `apps/web/e2e/visits/scheduler.spec.ts` | Open scheduler → pick slot → book → confirmation |
| Inventory | `apps/web/e2e/inventory.spec.ts` | Open inventory → filter by BHK+facing → click unit → see detail |
| Booking Pipeline | `apps/web/e2e/booking/pipeline.spec.ts` | Sales exec initiates booking → uploads token receipt → admin/owner approves |
| Reminders | `apps/web/e2e/reminders/banner.spec.ts` | T-2h banner appears on Lead Detail → click "On my way" |
| Audit Log | `apps/web/e2e/audit/log.spec.ts` | Admin opens audit log → filter by user → see latest reassign with reason |
| Notification Center | `apps/web/e2e/notifications/center.spec.ts` | Trigger notification → bell badge updates → click item → deep-links to entity |
| Manager Dashboard | `apps/web/e2e/dashboard/manager.spec.ts` | Login as manager → 4 KPIs render → click reassign from queue |
| Admin Dashboard | `apps/web/e2e/dashboard/admin.spec.ts` | Login as admin → see all teams → reassign cross-team |
| RERA Export | `apps/web/e2e/compliance/rera-export.spec.ts` | Admin → Compliance → export → file downloads with RERA# in every record |
| Mobile PWA | `apps/web/e2e/mobile/pwa.spec.ts` | View at 375px → Lead Inbox renders as card list → Lead Detail shows mobile tabs |

### 19.5 Mobile E2E (Maestro flows)

3 critical mobile flows:

- `apps/mobile/.maestro/leads-inbox.yaml` - Login → Lead Inbox renders → FlashList scrolls 1000 leads smoothly → open lead
- `apps/mobile/.maestro/lead-detail.yaml` - Open lead → 5 tabs render → switch tabs → chat tab loads → send message
- `apps/mobile/.maestro/notification-center.yaml` - Background app → push arrives → foreground app → notification appears in Center

Each Maestro flow is ~50 lines of YAML. Run via `maestro test apps/mobile/.maestro/leads-inbox.yaml` on EAS build or via Expo dev client.

### 19.6 Test gating

- **PR checks** (must pass to merge): lint + type-check + Vitest unit + Vitest integration + Playwright E2E on web.
- **Nightly** (informational): k6 load tests, Maestro mobile flows (run on EAS dev build).
- **Pre-release** (Week 12): full test pyramid + 1-week soak in staging.

### 19.7 Test maintenance rule

Every new feature must ship with tests in the same PR. The PR description must include the test plan section: which unit tests added, which integration test coverage updated, which E2E flow extended. Engineer self-reviews the diff for missing tests before requesting review.

---

## AUTOMATED REVIEW PIPELINE - 2026-08-31 (/autoplan)

Ran by Hermes (autoplan skill). Voices: Codex CLI 0.151.0 via local OmniRoute gateway
(model `ollamacloud/glm-5.3-flash`) - Codex was not installed; installed for this review.
Three earlier Agency-specialist subagent passes died to upstream 503s; the four voices
below were re-run through Codex and their file-level claims were verified against the
repo before acceptance. Claude primary analysis ran in parallel at full depth.

---

# PHASE 1 - CEO REVIEW (Strategy & Scope)

Mode: SELECTIVE EXPANSION (auto-selected). Restore point captured before any edit.

## Step 0A - Premise Challenge

| # | Premise | Status | Evidence |
|---|---------|--------|----------|
| P-1 | 13-week timeline is achievable | CHALLENGED (High) | Includes Store approval in Week 10 with no buffer; Apple review alone routinely takes 1-7 days plus rejection cycles. |
| P-2 | FreJun is the right telephony vendor | ASSUMED | Rs 15,300/mo is 84% of recurring cost; no exit terms, no alternate pilot named anywhere in the plan. |
| P-3 | 4-8h/month on-call is enough for a self-hosted stack | CHALLENGED (High) | Stack = Postgres + PgBouncer + Redis + 2 app containers + Coolify + backups. Patching alone eats the budget in some months. |
| P-4 | 12 WhatsApp triggers default-on for 10 users | ASSUMED | No volume estimate, no opt-out fatigue analysis; Meta template rejections not accounted in Week 1. |
| P-5 | Client staff will adopt Model C process | RISK ACKNOWLEDGED | Plan says it requires "enforcement" (§11.4) but ships no adoption tracking beyond KPI dashboard. Accepted as-is; measurement exists. |
| P-6 | Custom build beats buying | DEFENSIBLE | 4-5 staff workflows (Model C ownership transfer, FreJun call logging) are not served by off-the-shelf CRMs at ₹18,300/mo total cost. Accepted (P6). |

## Step 0B - Existing Code Leverage (What already exists)

| Sub-problem | Existing code | Plan reuses it? |
|---|---|---|
| Monorepo + tooling | scaffold: turbo.json, 4 packages, pnpm workspace | Yes (Week 1 tasks mostly done already) |
| Schema | 21 models in packages/database/prisma/schema.prisma | Yes |
| RLS | 25 policies in packages/database/prisma/rls/policies.sql + withRlsContext | Yes, but see Eng gaps (G-1, G-2) |
| Auth server | packages/auth-client/src/auth.ts (better-auth: jwt + admin, env assert) | Yes; plan §6 drifts (shows `apiKey()` plugin and file under apps/web - actual shared instance is in packages/auth-client) |
| Boot validation | verifyPoolMode() in apps/backend/src/main.ts:19 + assertAuthEnv() | Partially - see DX (X-3) |
| Seed | packages/database/src/seed.ts with UPPERCASE roles | Yes; plan §17 Input #5 sketch shows lowercase roles - drift |

## Step 0C - Dream State Mapping

```
CURRENT                       THIS PLAN                         12-MONTH IDEAL
Scaffold: schema, RLS,   -->  v1 live: web+mobile CRM,     -->  CRM is the client's single
13 modules, no CI,            WhatsApp+telephony,               revenue system; 2nd project on
no migrations,                SLOs, backups, runbook,           the same stack; PaalStack runs
no mobile                     13-week handoff                   2-3 client CRMs as a product
```

Delta: plan closes ~80% of the gap to the 12-month ideal. The remaining 20% = adoption
mechanics (Model C enforcement, training cadence) and vendor operational sustainability,
both named in §11 risks. Dream state is served.

## Step 0C-bis - Implementation Alternatives

```
APPROACH A: Build v1 as planned (13-week, self-hosted, all 4 surfaces)
  Effort: L   Risk: Medium
  Pros: exact Model C fit; telephony+WhatsApp depth owned; cost ceiling known
  Cons: timeline pressure; vendor on-call load; FreJun lock-in
  Reuses: existing scaffold heavily

APPROACH B: Phased MVP - web-only + WhatsApp first 8 weeks, mobile in v1.1
  Effort: M   Risk: Low
  Pros: kills Apple/Google risk entirely in 2026; faster to value; mobile PWA covers field use
  Cons: deviates from signed design (mobile is a locked client decision)
  Reuses: everything in A
APPROACH C: Buy (Zoho/LeadSquared) + WhatsApp automation glue
  Effort: S   Risk: Low
  Pros: ships in 2-3 weeks
  Cons: no Model C ownership automation, no FreJun tie-in, per-seat costs grow
```

RECOMMENDATION: Choose A (P1 completeness + client sign-off already locks mobile).
B is viable if the client approves a mobile slip at Week 9 check-gate. C rejected (P3).

## Step 0D - SELECTIVE EXPANSION Analysis (expansion candidates auto-decided)

| # | Expansion | Blast radius | CC effort | Decision |
|---|-----------|--------------|-----------|----------|
| E1 | Offline visit-outcome queue (Design voice, critical) | mobile + visits module | <1d | APPROVE (P1, P2 - field use is the product) |
| E2 | SSE stream tickets replacing raw JWT in query param (Eng, critical) | backend realtime | <1d | APPROVE (P1 security) |
| E3 | Telemetría de adopción semanal | - | - | DEFER → TODOS.md (outside radius) |
| E4 | Alternate telephony pilot | - | - | DEFER → TODOS.md (client decision) |

## Step 0E - Temporal Interrogation

- HOUR 1: migrations don't exist yet; policies.sql has no apply path (see Eng G-5). First implementer hits this within the hour.
- HOUR 2-3: role casing drift (schema UPPERCASE vs plan sketches lowercase) will bite in RLS tests.
- HOUR 4-5: reassign flow needs withRlsContext wiring that the plan's snippet omits.
- HOUR 6+: reminder cron idempotency under lock expiry - nobody plans for the 61st second.

## CEO Consensus Table

```
CEO DUAL VOICES - CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                            Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Premises valid?                   mixed  mixed   PARTIAL - app-store & on-call premises challenged (CONFIRMED concern)
  2. Right problem to solve?             yes    yes   CONFIRMED
  3. Scope calibration correct?          yes    yes   CONFIRMED
  4. Alternatives sufficiently explored?  no     no   CONFIRMED GAP - alternatives table shallow (buy/no-code dismissed by assertion)
  5. Competitive/market risks covered?    no     no   CONFIRMED GAP - no market-scan or pivot gate
  6. 6-month trajectory sound?           mixed  mixed  PARTIAL - lock-in/handover terms undocumented
═══════════════════════════════════════════════════════════════
```

**CODEX SAYS (CEO - strategy challenge).** 7 findings, all verified as grounded in plan text:
app-store review buffer (High), FreJun single-vendor validation + pilot (High), on-call underestimate (High),
WhatsApp default-on volume (Medium), month-6 lock-in + handover contract terms (High),
alternatives scoring (Medium), client market-scan gate (High).

**Primary (Claude) CEO analysis.** 6 premises assessed (table above). Sections 1-10 findings:
- §1 Premise: P-1/P-2/P-3 as above. Nothing flagged on problem framing - Model C time-to-first-touch is the
  right KPI and the plan measures it (§13).
- §2 Error & Rescue: WhatsApp send failure path (graceful queue) specified; FreJun webhook 503 path specified;
  Meta webhook dedupe exists (WebhookEvent). GAP: push receipt polling failure has no alert path (P1 perf
  gate measures delivery but nothing fires a Telegram alert on systematic FAILED status).
- §3 Security: seed passwords (`CHANGE_ME_ON_FIRST_LOGIN`) have no forced-rotation mechanism named. GAP (P1 fix
  cheap): seed admin should get `mustChangePassword` flag or one-time login link.
- §4 Data/Edge: quiet-hours exists; SSE reconnect exists. GAP: no offline state for visit outcomes (see Design).
- §5 Quality: plan is specific and vocabulary-locked; no DRY violations introduced by plan itself.
- §6 Tests: §19 is the strongest section; RLS matrix gaps covered in Phase 3.
- §7 Performance: SLO table + k6 gates present; N+1 addressed (P3).
- §8 Observability: monitoring free tier listed; add SLO-breach alerts to Telegram channel (same alerting
  as uptime).
- §9 Deploy: staging soak + restore test present. Deploy-time risk window: Coolify auto-deploy from main with
  manual approval - fine.
- §10 Trajectory: reversibility 3/5 (DB + RLS are sticky; otherwise standard). Debt: none material.

**Failure Modes Registry (CEO phase):**

| CODEPATH | FAILURE MODE | RESCUED? | TEST? | USER SEES? | LOGGED? |
|----------|--------------|----------|-------|------------|---------|
| WhatsApp send | Meta 4xx/5xx | Y (queue+retry) | Y (placeholder test) | graceful error | Y |
| FreJun webhook | signature mismatch | Y (503) | Y (integration) | nothing (silent, correct) | Y |
| Push receipts | systematic FAILED | N ← GAP | N ← GAP | staff notices late | N |
| Seed bootstrap | weak password unrotated | N ← GAP | N ← GAP | silent security debt | Y |
| Cron reminder | lock expiry mid-batch | PARTIAL (A3 lock) | planned | duplicate reminders | N |

**Dream state delta:** see 0C. **NOT in scope:** telephony vendor migration (client call),
adoption telemetry (TODOS.md), alternate-telephony pilot (TODOS.md).

## Phase 1 Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW - COMPLETION SUMMARY (CEO PHASE)       |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION (auto)                  |
| Step 0 premises      | 6 assessed, 3 challenged → surfaced at gate |
| Section 1  (Arch)    | 2 gaps (push alerts, offline outcomes)      |
| Section 2  (Errors)  | 3 gaps (push FAILED alert, seed pwd, cron)  |
| Section 3  (Security)| 1 finding (seed password rotation)          |
| Section 4  (Data/UX) | 1 edge-case gap (offline outcomes)          |
| Section 5  (Quality) | no findings (no code written yet)           |
| Section 6  (Tests)   | covered in Phase 3                          |
| Section 7  (Perf)    | covered by §13.1 (good)                     |
| Section 8  (Observ)  | 1 gap (SLO-breach alerts)                   |
| Section 9  (Deploy)  | no findings                                 |
| Section 10 (Future)  | reversibility 3/5; lock-in documented §11   |
| Outside voice        | ran (codex, 7 findings)                     |
+--------------------------------------------------------------------+
```

**PHASE 1 COMPLETE.** Codex: 7 concerns. Primary: 6 sections with findings, 3 GAP rows.
Consensus: 3/6 confirmed, 1 partial, 2 disagreements → surfaced at gate.

---

# PHASE 2 - DESIGN REVIEW (UI scope detected: 11 locked UI decisions + wireframes)

Codex design voice ran with access to plan + WIREFRAMES.md; it computed contrast ratios itself
(matching values shown below). Primary verified the wireframes exist and lock the layouts.

**CODEX SAYS (design - UX challenge):** 8 findings:
1. Telecaller first screen = dense table; should be an action-ranked call queue (High).
2. Mobile 5 equal tabs; Overview/Chat dominate - group rest under More (Medium).
3. Specified states: only empty states; loading/error/partial/retry unspecified per surface (High).
4. Offline visit-outcome logging absent - Critical for field use in poor connectivity.
5. SSE reconnect UX: "Reconnecting..." pill exists but placement/visibility/recovery undefined (High).
6. Model C handoff UX reads as neutral transfer; feels punitive to the telecaller losing the lead (High).
7. Unspecified implementations: Calendar, Toast, Sheet-vs-Modal, upload, optimistic chat, table density (High).
8. Accessibility: contrast computed against #f8f5ef surface - amber #f59e0b 1.97:1, green #16a34a 3.03:1,
   red #dc2626 4.44:1. Text-on-chip for amber/green FAILS WCAG AA. Fix: darker text tokens
   (#92400e / #166534 / #991b1b-class) or fill chips with tinted bg + dark text; ≥44px targets (Critical).

Primary pass verdicts (auto-decided):
- D1 (telecaller queue): TASTE - auto-decided per Decision 0.2 (inbox sort already serves this; a
  separate queue = duplicate surface, P4). Surfaced at gate as a taste choice.
- D2 (tab grouping): conflicts with locked Decision 0.1 (user-locked). KEEP 0.1; noted.
- D3 (missing states): structural - auto-FIX into scope (P1, P5). Added as Eng task T-D3.
- D4 (offline outcomes): APPROVE as scope (P1). Added as task T-D4 (blast radius: mobile, backend - <1d CC).
- D5 (SSE status pill): APPROVE (P5 explicit). Added to T-D3 spec.
- D6 (handoff emotion): TASTE - decision 0.8 is client-locked; the fix (credit-preserving full-screen
  acknowledgment) is a variant, not a defect. Surface at gate.
- D7 (unspecified components): auto-FIX via WIREFRAMES.md being the reference (it locks these); verify
  before Week 5 builds. Logged.
- D8 (contrast tokens): structural - AUTO-APPROVED (P1). Update ui-tokens token values + wireframes note.

Design litmus: plan had 7/10 before this pass; contrast + states push to 8/10 after fixes above.

**PHASE 2 COMPLETE.** Codex: 8 concerns. Consensus: 5 confirmed, 2 taste → gate, 1 user-locked.

---

# PHASE 2.5 - DX REVIEW (developer-facing scope detected: env wiring, CI, agent conventions)

**CODEX SAYS (DX - developer experience challenge):** 6 findings (verified against repo by primary):
1. TTHW ≈ 20-30 min, 7 steps; `packages/database/test/rls-isolation.test.ts:14` references
   `pnpm docker:up` but root package.json has NO `docker:up`; `policies.sql` is not applied by any
   script or migration. High. Fix: root scripts `docker:up`, `db:migrate`, `db:policies`, `db:seed`, `setup` + README.
2. Plan §19.1 cites "Per AGENTS.md" but no root AGENTS.md exists (only generated apps/web one). Medium.
   Fix: create root AGENTS.md with the real conventions.
3. Boot fail-fast covers only POOL_MODE: Redis silently defaults to localhost (redis.module.ts:15),
   JWT secret not boot-validated, PgBouncer healthcheck is service_started only. High.
4. Docs: README W1, ARCHITECTURE W2, RUNBOOK W2-3, DEPLOY W3-4 (Codex gave two cadences across runs;
   adopt the earlier one). Medium.
5. 128-case RLS matrix unreachable: describe.todo skeleton only. High. Fix: disposable PG test service +
   procedural 4×8×4 generation using withRlsContext.
6. Root missing: .env.example, README.md, .github/workflows. High.

Developer journey map (9 stages): discover(absent) → clone(ok) → env(FAIL: no template) → deps(ok via pnpm) →
db(FAIL: no docker:up/migrations/apply-path) → test(degraded: skeleton) → debug(weak: only POOL_MODE check)
→ docs(absent) → contribute(undocumented conventions).
Empathy narrative: "I cloned the repo at 6pm. pnpm install works. Now what? No README, no .env.example -
I read docker-compose and guess 5 vars, hit a POOL_MODE error that at least tells me what to fix, then
discover tests reference scripts that don't exist. I stop."
DX Score: initial 4/10 → 8/10 after T-X1..X4. TTHW: 20-30 min → target < 5 min.

**PHASE 2.5 COMPLETE.** DX 4/10 initial. Consensus: 6/6 confirmed.

---

# PHASE 3 - ENG REVIEW (final gate)

## Step 0 - Scope challenge: actual code read
Read: policies.sql (25 policies, verified), rls.ts (verified transactional SET LOCAL pattern - good),
auth.ts (better-auth: jwt+admin only - plan §6 shows `apiKey()` and organization() comment matches),
redis.module.ts (silent localhost default - verified), main.ts (verifyPoolMode only - verified),
seed.ts (UPPERCASE roles - plan sketches lowercase - drift confirmed), docker-compose (POOL_MODE=session,
max_connections=300, pg+redis healthchecks present, pgbouncer healthcheck absent - verified).

## Architecture (Section 1) - dependency graph

```
                    ┌──────────────────────────────┐
                    │  Expo mobile (Week 10)       │
                    │  react-native-sse            │
                    └────────────┬─────────────────┘
                                 │ HTTPS (JWT)
┌──────────────────┐   REST   ┌──▼───────────────────┐    SQL (pooled, session)   ┌──────────────┐
│ Next.js 16 BFF   ├──────────►  NestJS 12 backend    ├────────────────────────────►  PgBouncer    │
│ better-auth      │          │  13 modules          │      SET LOCAL per tx      │  (session)   │
│ web UI + inbox   │          │  SSE + crons         │◄───────────────────────────┤  → Postgres16│
└───────┬──────────┘          └──┬───────────┬───────┘    DIRECT_URL (migrate)     │  max_conn 300│
        │ auth tables only       │           │                                     └──────────────┘
        ▼                        │ Redis pub/sub + cron locks + webhook queue
     Prisma (bare, NO RLS)◄──────┘           │
                                             ▼
                              WhatsApp Cloud API ⇄ Meta webhooks; FreJun webhooks → R2
```

Coupling: business writes MUST flow through withRlsContext; bare prisma is correct only for
(migrations, seed, better-auth session tables, webhook ingest, system crons). The plan's own §18
controller sketch violates this (calls this.prisma directly) - with a DB owner role, RLS silently
does not apply. This is the single most important architectural gap. Scaling: first breaker at 10x
is SSE connection budget (documented, capped at ~150 users); second is Postgres single instance (no
hot standby - acceptable for v1, name it in the runbook).

## Section 2 - Code Quality findings (auto-decided)

| # | Finding | Sev | Principle | Decision |
|---|---------|-----|-----------|----------|
| G-1 | Bare `prisma` used in request-path code + plan §18 controller sketch bypasses RLS by design (owner role) | critical | P1 | Auto-fix: plan amended (see "Plan amendments" below) - reassign + all request-scoped business writes go through withRlsContext; bare client reserved for named system paths |
| G-2 | `reminder_select_manager` policy grants ALL team reminders to any MANAGER without teamId check (policies.sql:241) - cross-team leak if >1 manager team | critical | P1 | Auto-fix: add `AND "leadId" IN (SELECT id FROM "Lead" WHERE "teamId" = ...)`, or scope Reminder to teamId column; add to 128-case matrix |
| G-3 | Unset session vars fail OPEN for some paths: `reminder_select_owner` ORs role checks without team scope; `auditlog_insert_any_authenticated` needs only user_id (spoofable user_id within RLS role context is possible via SET LOCAL) | critical | P5 | Auto-fix: every policy gets all three var checks (user_id + role + team where relevant); deny-when-unset tests added to matrix |
| G-4 | Cron lock TTL 50s vs batch >60s → duplicate reminder fires; lock blind-deleted in finally | high | P1 | Auto-fix: lease renewal (EXPIRE bump inside loop) + idempotency claim (`status SCHEDULED→PROCESSING` conditional updateMany) + owned-token release |
| G-5 | No CI, no migrations dir, no policy-apply path (policies.sql never run by pnpm db:migrate) | high | P1/P6 | Auto-fix: Prisma migration applying policies; GitHub Actions CI (lint+typecheck+test) Week 1; flagged "see something" |
| G-6 | Plan §6 auth sketch shows `apiKey()` plugin; code uses jwt+admin only | low | P5 | Auto-fix: plan already half-corrected (A4 note); amend §6 sketch to match code |
| G-7 | Role casing: plan sketches lowercase ('admin','manager'); schema/policies/seed use UPPERCASE | low | P5 | Auto-fix: plan §18 guard + §17 inputs updated to enum casing |
| G-8 | Redis silent `localhost:6379` default masks missing REDIS_URL | high | P1 | Auto-fix: fail-fast boot check for REDIS_URL/JWT_SECRET/BETTER_AUTH_URL + PgBouncer reachability (DX X-3) |

## Section 3 - Test review (NEVER compressed)

New flows → coverage map:

| # | New flow / codepath | Test type | In plan? | Gap / decision |
|---|--------------------|-----------|----------|----------------|
| 1 | Model C state machine transitions | Unit | Y (§19.1, 100%) | OK |
| 2 | RLS isolation per role×table×action | Integration | Y (§19.2) but skeleton | Must become real (X-5); add G-2/G-3 negative cases |
| 3 | Reassign (admin/manager) | Unit+Integration | Y | Add: coOwnerId cleanup assert, ADMIN-owner rejection, NEW-state-to-exec invariant test |
| 4 | SSE resume (Last-Event-ID) | Integration | Y (sse-resume) | Add unset-var negative test |
| 5 | Reminder cron duplicate-fire | Unit (lock + idempotency) | Partial (A3) | Update processor test for lease-expiry + double-claim |
| 6 | WhatsApp inbound (dedupe + archive) | Integration | Y | OK |
| 7 | FreJun inbound → R2 | Integration | Y | OK |
| 8 | Booking approval transactional audit | Integration | partial | Add: audit-row-missing ⇒ rollback test |
| 9 | Push receipts FAILED | Unit | N ← GAP | DECIDED: add unit test + Telegram alert on threshold (ties to E-2) |
| 10 | Seed bootstrap | Integration | N | DECIDED: add (weak-password guard test) |
| 11 | Offline visit-outcome queue | E2E (mobile) | N | DECIDED: Maestro flow + conflict-resolution unit test |
| 12 | k6 load gates | Load (nightly) | Y (T1) | OK |

Evals/LLM: none in v1 (no LLM in critical path). 2am-Friday test: `reassign.test.ts` + RLS matrix.
Hostile-QA test: cross-team MANAGER reminder read (G-2) + reassign to ADMIN role (G-7).

## Section 4 - Performance
§13.1 SLO budgets + 3 k6 gates are in the plan and are the right shape. Additional: reminder cron
take:100 loop must batch with skip/limit paging when backlog > 100 (edge case); SSE replay take:100
matches §5 fine. Connection budget documented (150-user cap).

## Deployment (Section 9): staging soak + restore test + RUNBOOK present. Rollback = Coolify previous
release; DB migrations backward-compatible requirement should be stated as a rule (add to §19.6).

## Failure Modes Registry (Eng phase)

| CODEPATH | FAILURE | RESCUED | TEST | USER SEES | LOGGED |
|----------|---------|---------|------|-----------|--------|
| Reassign | partial steps after owner update | N (pre-fix) | planned | divergence owner/reminders | audit gap |
| Business write via bare prisma | RLS silently bypassed | N ← GAP | N | invisible | N |
| Reminder cron | TTL expiry dup-fire | PARTIAL | planned | duplicate reminders | N |
| Redis down | silent localhost default (local only) | N ← GAP | N | confusing ECONNREFUSED later | N |
| policies.sql | never applied → RLS off | N ← GAP | N | silent (worst kind) | N |

**Critical gaps: G-1, G-2, G-3, G-5 (policies never applied).** All auto-fixed via plan amendments + task list.

## Test-plan artifact
Written to: `~/.gstack/projects/shadhil-crm-plans/2026-08-31-main-test-plan.md`

## TODOS.md items (auto-collected)
- T-ALT: alternate telephony pilot evaluation (client decision, P2)
- T-ADOPT: weekly adoption telemetry (P3)
- T-CI: nightly k6 + Maestro runner wiring in CI (P2)

## Eng Completion Summary

```
+====================================================================+
|        MEGA PLAN REVIEW - COMPLETION SUMMARY (ENG PHASE)           |
+====================================================================+
| Mode                | FULL_REVIEW (required gate)                  |
| Section 1 (Arch)    | 2 findings (G-1 wiring, SSE conn cap OK)     |
| Section 2 (Errors)  | 5 gap rows in failure registry               |
| Section 3 (Security)| 3 critical (G-1..G-3) + casing (G-7)         |
| Section 4 (Data/UX) | offline queue + reconnect spec added         |
| Section 5 (Quality) | 8 findings auto-decided                      |
| Section 6 (Tests)   | 12-row map, 3 new tests decided              |
| Section 7 (Perf)    | covered (SLO table good)                     |
| Section 8 (Observ)  | 1 gap (push FAILED alert → Telegram)         |
| Section 9 (Deploy)  | backward-compat migration rule to add        |
| Section 10 (Future) | reversibility 3/5; FreJun lock-in flagged    |
| Outside voice       | ran (codex eng pass, 10 findings)            |
+====================================================================+
```

**CODEX SAYS (eng - architecture challenge):** 10 findings - transactional audits, SSE tokens,
prisma bypass (critical), policy fail-open (critical), reassign atomicity (critical), owner
invariants, state-handoff mismatch, cron dup-fire, CI/migration gap, "test coverage is fake"
(critical, refers to skeleton state). Primary verified every code-referenced claim against the
repo before accepting (all check out, G-2 wording refined: the Reminder manager policy is the
concrete leak).

**PHASE 3 COMPLETE.** Codex: 10 concerns. Consensus: 5/6 confirmed (deployment risk = N/A missing
voice→CONFIRMED by primary), 1 disagreement (scope: codex would cut mobile; P2 override - plan is
client-locked) → surfaced at gate.

---

## USER CHALLENGES (queued to Final Approval Gate)

1. **NEW→Sales-Exec manual reassign breaks the Model C ownership invariant.** Plan §18 says it is
   allowed ("state machine doesn't care who set the owner"). Both voices flag: either forbid exec
   targets while state < VISIT_SCHEDULED, or define the state machine exception explicitly.
2. **Contrast tokens fail WCAG AA.** Amber/green/red status colors as given fail contrast on the
   locked surface. This changes §4 tokens - a locked decision area - so it is surfaced, not auto-applied.
3. **Mobile in 13 weeks.** Store review risk (P-1). Options: keep plan as-is (default), or add the
   Week 7 TestFlight/internal-track submission gate + 2-week buffer.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode = SELECTIVE EXPANSION | mechanical | - | skill default for feature iteration | - |
| 2 | CEO | Approach A (build as planned) | mechanical | P1,P6 | client sign-off locks mobile+stack | B,C |
| 3 | CEO | Expansion E1 offline queue → in scope | mechanical | P2 | in blast radius, <1d | defer |
| 4 | CEO | Expansion E2 SSE tickets → in scope | mechanical | P1 | security fix, small | - |
| 5 | CEO | E3 telemetry, E4 telephony pilot → TODOS | mechanical | P3 | outside radius | include |
| 6 | Design | D3/D5 missing states + reconnect spec → in scope | mechanical | P1,P5 | structural, cheap | - |
| 7 | Design | D8 contrast tokens → in scope | mechanical | P1 | WCAG AA is a floor | keep colors |
| 8 | Design | D1 telecaller queue | taste | P3 | surfaced at gate | - |
| 9 | Design | D6 handoff emotion variant | taste | - | surfaced at gate | - |
| 10 | Eng | G-1 RLS wiring mandatory via withRlsContext | mechanical | P1 | security | - |
| 11 | Eng | G-2 Reminder manager policy scope fix | mechanical | P1 | cross-team leak | - |
| 12 | Eng | G-3 deny-when-unset policy hardening | mechanical | P5 | fail-closed | - |
| 13 | Eng | G-4 cron lease+idempotency | mechanical | P1 | dup-fire | - |
| 14 | Eng | G-5 CI + migrations + policy apply | mechanical | P1,P6 | shipping gate | - |
| 15 | Eng | G-6/G-7 drift fixes (auth sketch, role casing) | mechanical | P5 | docs match code | - |
| 16 | Eng | G-8 boot env fail-fast | mechanical | P1 | DX gap | - |
| 17 | Eng | Codex scope-cut (drop mobile) | REJECTED | P2 | client-locked decision | cut mobile |
| 18 | Gate D2 | Auto + manual assignment BOTH in scope; rule engine semantics defined (priority/criteria/catch-all/fallback); T-ARM added | mechanical | P1 | user direction 2026-08-31 "both leads manually reassign + auto assign based on situation" | B (load/SLA re-routing) |
| 19 | Design | App-shell redesign approved: sidebar + role-tuned charts + mobile Sheet + friendly labels in one PR (user picked option B from D1) | mechanical | P1,P2,P3 | one shipping surface vs. two PRs of partial work | (A) topbar-only, (C) split across 3 PRs of half-features |
| 20 | Design | D2: friendly labels in UI, enums in DB - server keeps `Lead.status` etc. raw; UI maps via `lib/labels.ts` with source-of-truth test | taste | P2,P6 | non-technical staff read "Talked" not "CONTACTED" | (A) raw enums everywhere |
| 21 | Design | D3: role-tuned chart defaults - Telecaller 1, Manager 3, Admin 4. Charts gated on backend module landing (ModulePending until then) | taste | P2,P3 | each role sees work relevant to them, not the same dashboard for everyone | (B) one chart set for all |
| 22 | Design | D4: floating "+ Add lead" FAB, mobile-only (`md:hidden`), role-gated (telecaller/exec/manager+), hides when offline (silent-offline gap from eng §4) | mechanical | P1,P3 | first-touch latency matters; FAB is the mobile-first pattern | (A) header button only, (B) page-level button only |
| 23 | Eng | Single source of truth for nav: `lib/nav.ts` exports `NAV_ITEMS` + `getVisibleNav` + `isNavItemActive` + `useNavSync`; sidebar + topbar both read it (DRY §2 P1) | mechanical | P6 | parallel arrays in two files always drift | inline arrays in each shell |
| 24 | Eng | ChartCard = thin glue around `ModulePending`, not an independent state machine (eng §1 P1); reuses loading/error/empty contract | mechanical | P1,P5 | one state machine, one place to update when T19 lands shape-matched skeletons | (A) ChartCard owns its own pending copy |
| 25 | Eng | `lib/labels.ts` source-of-truth test (`labels.test.ts`) asserts every §9.1 enum value has a friendly entry - fails the build if a Prisma enum gains a value but the UI table doesn't | mechanical | P5,P6 | the raw-enum-leak bug can only happen once | manual review |
| 26 | Eng | `SidebarProvider` is `'use client'` - `(app)/layout.tsx` is a client component on purpose. Proxy redirects cookieless visitors to `/login` before this layout ever renders, so SSR is unnecessary here (eng §1 P1 documented as deliberate) | mechanical | P5,P6 | avoid "shell appears before session" flash | (A) split server/client, (B) try to make sidebar SSR-safe |
| 27 | Eng | recharts primitives (`Bar`, `BarChart`, `XAxis`, `YAxis`) imported from `recharts` directly; library v1.4.1 only re-exports the wrapper (`Chart`/`ChartContainer`/`ChartTooltip`). Per shadcn charts convention: wrappers from the lib, primitives from the engine. | mechanical | P1,P5 | skill docs and library v1.4.1 barrel disagree - re-export doesn't exist; adding `recharts: ^3.8.1` to consumer package.json is the canonical shadcn split | (A) inline reimplementation, (B) vendor a `Chart` shim |
| 28 | Design | Sidebar brand color via `--sidebar*` tokens in `packages/ui-tokens/src/brand.css` (NOT `all.css` - library-owned). Brand = navy + green (decided in commit c1118a7); plan §12's "orange/amber" was the planner's assumption, the actual brand is on disk | taste | P2 | brand.css is documented as the only file you edit per project; the sidebar tokens live with the brand | (A) override in `globals.css` per app, (B) hardcode colors in app-shell.tsx |
| 29 | Eng | PR split: PR1 (T1–T15 shell+labels+signOut+nav test), PR2 (T16–T19, T26, T27 skeleton layer), PR3 (T20–T25, T28–T38 polish+safety+bring-backs). Locked in re-review §9; each PR is independently revertable. | mechanical | P1,P6 | smaller PRs review faster; each layer is mechanically separable | (A) one giant PR, (B) split by file ownership |
| 30 | Design | `useNavSync()` hook in `lib/nav.ts` closes the mobile Sheet on `usePathname()` change. Encapsulates the library-drift risk so future library updates don't silently reintroduce the "stuck open Sheet" bug. | mechanical | P1,P6 | without this hook, the mobile Sheet would block the route change; library doesn't auto-close | (A) close-on-click handler per link, (B) library's default behavior (assumed but not guaranteed) |
| 31 | Eng | Skeleton is one generic component with variants (`text`/`card`/`chart`/`table`/`kpi`/`user`), not 4 dedicated files (CEO §5 1D). `SkeletonContainer` cross-fade = CSS-only (`opacity-0/100 duration-200` + `motion-reduce:transition-none`). T32 (shape-count tests) + T33 (computed-style assertion) replace fragile `vi.useFakeTimers` for animations. | mechanical | P1,P6 | DRY; CSS animations are not pauseable by fake timers (known pitfall) | (A) 4 dedicated files, (B) fake-timer-based tests |
| 32 | Design | ErrorBoundary fallback = `Empty`, not `Skeleton` (CEO §1 1B). A skeleton hides the failure; `Empty` makes the failure visible so the user can report it. Applied at the chart layer in T31. | taste | P1,P5 | honest error surface | (A) generic error.tsx, (B) skeleton as fallback |
| 33 | Eng | Standalone bare-`node:http` SSE service (`apps/realtime-sse`, port 8090) instead of `@Sse()` in Nest or `@fastify/sse` plugin. Both framework SSE layers are broken for any subscription that needs `await` inside its factory (verified 2026-09-04: Nest 12.0.1 + fastify-sse 0.6.0 both swallow frames silently). Bare-Node is the only path with empirical evidence. | mechanical | P1,P5,P6 | Nest has only 1 published 12.x version (12.0.1) - no upstream patch; downgrading is 6-module blast radius; fastify is the same shape of bug. Standalone service is ~260 lines, zero new runtime deps, and uses the exact pattern the canary proved works. | (A) keep Nest `@Sse` and pray for 12.0.2, (B) downgrade to 11.2.3, (C) use `@fastify/sse` |
| 34 | Eng | SSE consumer gets a distinct subdomain `sse.crm.shadhilbuilders.in` (not a path on `api.crm.shadhilbuilders.in`). Three subdomains total: `crm.shadhilbuilders.in` (web, user-facing apex), `api.crm.shadhilbuilders.in` (Nest + ticket mint, child of the app's parent), and `sse.crm.shadhilbuilders.in` (SSE, sibling of the app). The h2 connection-pool isolation and operational visibility are the two reasons (cookie isolation handled separately by Decision #37, and is now a hard requirement because the API is a child of the app's parent domain). | mechanical | P1,P5 | h2 multiplexing pool is per-origin in browsers, so isolating SSE prevents it from starving the API's h2 stream IDs. Long-lived connections have a different ops shape (timeouts, buffering, dashboards). The API and SSE subdomains are both children of the user-facing app's parent (`crm.shadhilbuilders.in`), so each is its own origin for h2/cookie/CSP purposes. | (A) `api.crm.shadhilbuilders.in/api/sse/*` (same origin as API = pool coupling), (B) `crm.shadhilbuilders.in/api/sse/*` (web origin = better-auth cookie in URL) |
| 35 | Eng | (SUPERSEDED 2026-09-04 by #36) Originally: Caddy terminates TLS + serves h2 to the browser for the SSE host; standalone service stays plain HTTP/1.1 on `localhost:8090`. | mechanical | P1,P5 | - | - |
| 36 | Eng | **Use Traefik (Coolify's default) for all three subdomains**, not Caddy. Coolify is built around Traefik - every tutorial, every issue thread, every GH discussion in coollabsio/coolify assumes Traefik. Caddy has known override bugs in Coolify's label system (Issues #3083, #2069) that the Traefik path doesn't have. SSE works out of the box on Traefik because it auto-detects streaming on `Content-Type: text/event-stream` (no explicit `flushInterval` config needed per official Traefik v3 docs). The only required SSE-specific override is excluding `text/event-stream` from the compression middleware. | mechanical | P1,P5 | Traefik is the default and most-tested Coolify proxy; choosing anything else means fighting the platform on every non-default config. The dedicated-Caddy split I considered (in the same turn) was the right shape of solution to a problem that vanishes when you use the platform's first-class citizen. | (A) Caddy with the dedicated-container split (operationally heavier, no upside), (B) nginx (same as Caddy - non-default in Coolify) |
| 37 | Eng | **Better-auth session cookie is explicitly scoped to `crm.shadhilbuilders.in`** (not `.crm.shadhilbuilders.in` and not `.shadhilbuilders.in`). Set via the `Domain` attribute on the session cookie in `packages/auth-client/src/auth.ts` (the `useCookies` config of the better-auth instance). The three subdomains are `crm.shadhilbuilders.in` (app), `api.crm.shadhilbuilders.in` (API), and `sse.crm.shadhilbuilders.in` (SSE). The API is intentionally a *child* of the user-facing app's parent (`api.crm.shadhilbuilders.in` shares the `crm.shadhilbuilders.in` parent with the app), so without explicit scope the browser would auto-send the session cookie to the API by RFC 6265. The BFF mints a fresh JWT before calling the API, so the API never needs the better-auth cookie in the current architecture - but the explicit scope is now a hard requirement (not just defense-in-depth), because the parent domain is shared. | mechanical | P1,P5 | RFC 6265 cookie scoping: when `Domain` is unset, the cookie is host-only; when `Domain: crm.shadhilbuilders.in` is set, the cookie is sent to that host AND all subdomains (`api.crm.shadhilbuilders.in` and `sse.crm.shadhilbuilders.in` are both subdomains of `crm.shadhilbuilders.in`). To prevent the auto-send to `api.*`, the `Domain` attribute must EITHER be unset (host-only) OR set to a value that doesn't include the API's parent. Setting it explicitly to `crm.shadhilbuilders.in` (no leading dot, no parent match) is the documented better-auth way. | (A) Leave default (host-only, no explicit Domain attribute) - works today but breaks the moment anyone adds a cookie reader to the API, (B) Scope to `.shadhilbuilders.in` - wrong direction, sends cookie to all three subdomains including the SSE service, (C) Scope to `.crm.shadhilbuilders.in` - wrong direction, sends cookie to BOTH the app and the API |
| 38 | Design | Org admin UI lives under `/{orgSlug}/admin/*` and is OWNER/ADMIN only. Managers no longer see Users, Projects registry, or WA Unknown in the CRM nav; those screens move into the admin namespace with a layout gate. Work sidebar shows an Admin launcher (OWNER/ADMIN); admin sidebar hides Work + ProjectSwitcher and shows a Work launcher to the default project dashboard (or `/{orgSlug}/work` when empty). Former org-level admin routes are removed and return not found; there are no legacy redirects. | mechanical | P1,P2 | Command-center vs project-work chrome should not mix; MANAGER access to org admin surfaces was operational convenience that leaked an admin IA. Backend/RLS remains the security wall. | Keep MANAGER on Users / Projects / WA Unknown; mix Work + Admin nav on every route; retain legacy redirects |
| 40 | Eng (2026-09-13) | **Clean cutover of #39.** Drop `User.teamId`, drop `ProjectMember`, drop `JwtPayload.teamId` / better-auth additionalField / `app.user_team_id` GUC. JWT carries only `sub`/`role`/`organizationId`/`email`. Membership and project staffing are `TeamMember` + `Team.managerId` + `ProjectTeam` only. Chosen because the app is not in production (no live rows to dual-write or zero-drift-rehearse). | mechanical | P1,P5,P6 | Expand-contract was the right production strategy; with no operational users the dual-write window is pure drift surface. | Keep `User.teamId` as a display cache; keep a generated `ProjectMember` compatibility view |
| 41 | Eng (2026-09-13) | **`teammember_write_manager` RLS policy: a MANAGER may add/remove `TeamMember` rows on teams they MANAGE only.** Migration `20260913060000`. Scoped via `Team.managerId = app.user_id` (mirroring `lead_insert_manager`), NOT the role-only widening `phase_manager_write` used, because the authorization matrix restricts a MANAGER to managed teams. Additive alongside `teammember_write_admin` (ADMIN/OWNER keep org-wide write). | security | P1,P5 | The service layer (`TeamAccessService.canMutateTeam`) and the design doc's matrix both already granted this action, so RLS was the only layer refusing it - a MANAGER's write died with `42501`, and `deleteMany` matched 0 rows and reported `count: 0`, a SILENT no-op. Closing the gap at the policy layer keeps authorization decisions in one model instead of weakening the service check. | (A) Widen by role only like `phase_manager_write` - rejected, lets a MANAGER write into a team they don't lead and self-add to arbitrary teams; (B) relax the service guard instead - rejected, that hides the mismatch and still 42501s; (C) leave ADMIN-only and document the matrix as aspirational - rejected, the matrix is client-signed |
| 42 | Eng (2026-09-15) | **T-INV-SYNC: `Unit.status` becomes a DERIVED field.** A `SECURITY DEFINER` trigger on `Booking` (`unit_status_sync_booking`, migration `20260915060000_unit_status_sync`) recomputes it on every insert/update/delete - `APPROVED → SOLD`, else `TOKEN → TOKEN`, else `HOLD → HOLD`, else `AVAILABLE`. Application code stops writing `Unit.status` entirely (all four `unit.update` calls deleted from `bookings.service.ts`). Manual override narrows to the off-pipeline marks `AVAILABLE \| SOLD` via `UpdateUnitStatusSchema`, 409 when it contradicts a live booking. Adds partial unique index `one_active_booking_per_unit` (one `HOLD/TOKEN/APPROVED` booking per unit) + repair migration cancelling 16 duplicate active bookings (most-advanced, newest wins) and recomputing all units from their bookings. | architecture | P1,P5,P6 | Same failure class as #41, in the inventory domain: the sync ran as an `ADMIN`-only `Unit` UPDATE policy inside a user-scoped RLS transaction, so a MANAGER/SALES_EXEC/TELECALLER write matched ZERO rows with no error - 9 of 19 units drifted from their bookings (A-101 `AVAILABLE` while carrying one HOLD + one APPROVED; FA-001 `AVAILABLE` with 16 HOLD bookings) and `Unit.status=TOKEN` was unreachable. A second source was seed/demo scripts writing `Booking` directly (19 of 20 rows never passed through `BookingsService`; exactly one `booking.*` audit row existed). Moving the write into a trigger makes the derived column role-independent - and correct for seeds, crons and future writers by construction - instead of asking every future caller to remember a second write. | (A) Fix the service only + widen the RLS policy for MANAGER - rejected, seeds/scripts/crons still drift and the duplicate-write trap stays; (B) compute availability at read time and stop persisting the column - rejected, too invasive for this sweep (every inventory query, filter and badge) and the column is already indexed for filtering; (C) leave `Unit.status` hand-editable and just reconcile on a cron - rejected, a reconciliation job papers over the lie window rather than removing it |
| 43 | Eng (2026-09-15) | **T-BOOK-ROLES: booking transitions get role gates matching DESIGN.md §4, via the shared `isAdminClass()` helper.** Initiate (HOLD → TOKEN, and `create()`): MANAGER / SALES_EXEC / ADMIN / OWNER. Manager decision (→ APPROVED or REJECTED): MANAGER / ADMIN / OWNER - REJECTED is now gated too, not just APPROVED. Web mirrors it with `canInitiateBookings` + `canApproveBookings` so the UI cannot offer an action the API 403s. | security | P1,P5,P6 | Two independent authorization defects, found by probing all four roles against a real row. (1) The only gate in the service was `actor.role !== 'MANAGER' && actor.role !== 'ADMIN'` - a literal check that omitted OWNER, so the org owner was refused with `400 "Only MANAGER/ADMIN can approve"` while the UI offered them the Approve button (`canApproveBookings` includes OWNER) and the matrix grants Super Admin ✅. OWNER downcasts to ADMIN at the RLS layer everywhere else, so `isAdminClass()` is the correct, already-existing helper. (2) `create()` and HOLD → TOKEN had **no role gate at all**, so a TELECALLER who owned the lead could initiate a booking - matrix says ❌. RLS could not catch either: `booking_write_team` scopes by the parent Lead's owner/team and is role-blind, so "can write this row" was being mistaken for "may perform this action". | (A) Widen the literal check to `\|\| actor.role === 'OWNER'` - rejected, re-hand-rolls a role rule that `isAdminClass` already owns and leaves the next role addition to drift again; (B) enforce only in the controller - rejected, the service is the authorization layer every caller (incl. future mobile) shares; (C) rely on the RLS write policy - rejected, it is intentionally role-blind by lead scope, and the TELECALLER hole proves it does not express the matrix; (D) leave REJECTED ungated since it is not APPROVED - rejected, rejecting a booking ends the deal and is the same manager decision per §4 |
| 44 | Eng (2026-09-15) | **T-BOOK-APPROVE: the manager decision becomes a first-class action in the bookings table.** A new `BookingApprovalDialog` (`apps/web/src/components/bookings/`) is opened from the row-actions menu ("Approve / Reject", offered only on a `TOKEN` row to MANAGER/ADMIN/OWNER). It owns one `useForm` (zod) with a `decision` select + optional `reason`, and a `superRefine` that requires a reason for REJECTED. The old surface - a "Review approval →" link buried inside the "Owner / Approval" cell, reachable only by discovering it, and only a navigation to another page - is replaced by an "Awaiting approval" hint in that cell plus "View details" in the same menu. | mechanical | P2,P5 | The user asked for "a path in UI, currently in booking table to see the current specific booking option": the capability existed but was effectively undiscoverable, and the only entry point left the table. A row-actions entry point is where operators look for per-row operations, and it keeps the decision in context. The dialog also enforces the rejection-reason rule client-side, matching the service/audit expectation instead of surfacing a 400 after the fact. | (A) Keep the cell link and just make it a button - rejected, still leaves the table and is still hidden inside a data cell; (B) route approval to the existing detail page only - rejected, that page already had working actions, so the gap was never the mutation, it was discoverability from the list; (C) inline Approve/Reject buttons in a table column - rejected, a destructive/irreversible decision should not be a one-click hit target in a dense grid |
| 45 | Eng (2026-09-15) | **T-BOOK-LINK: the bookings table's Unit column leads the row and opens the BOOKING; Lead is plain text.** Column order: Unit → Lead → Status → Amount → Token → Created → Owner/Approval. Unit cell links to `/bookings/:id` with `data-qa="booking-unit-link"`; Lead renders as plain text. The `/bookings/[id]` page is unit-led: title `Unit A-101`, crumb `A-101 (Priya Sharma)`, matching card title, lead name keeping its own labelled row. Row actions: Approve/Reject (TOKEN + manager) · View details · View lead · Edit · Delete. | mechanical | P2,P5 | The Lead cell's `/leads/:id` target was a mechanical artefact of the slug-URL migration (commit 7115d1f) carried over unreconsidered, and the lead page renders no booking panel at all. Unit leads because it is the booking's natural key (`one_active_booking_per_unit`) and Wireframe #9 titles the surface `Booking - Unit A-204`. User direction settled the final shape: unit first and clickable, lead plain text ("i don't want lead to be clickable, make it normal text"). Keeping the lead in the row (as text) preserves the "who", and the row-actions "View lead" preserves the route to the CRM record. | (A) Lead-only link to the lead (the pre-change state) - rejected, the row is a booking and the destination showed nothing about it; (B) both Unit and Lead as links - rejected by the user, two live links in one dense row invites mis-clicks; (C) drop the lead path entirely - rejected, the lead record is a legitimate destination, it just should not be the row's primary hit target; (D) keep Unit as plain text and link only the lead - rejected, the unit is the identifier operators scan for |
| 46 | Eng (2026-09-15) | **T-BOOK-LEADSYNC: `Lead.state` now follows the booking lifecycle.** Pure mapping module `apps/backend/src/bookings/lead-state-sync.ts` (most-advanced ACTIVE booking wins): `APPROVED → WON`, `TOKEN → BOOKING_INITIATED`, `HOLD → NEGOTIATION`, none active → `NEGOTIATION`. Applied via a private `syncLeadState()` called inside the SAME transaction from `create()`, `transition()` and `delete()`. Direction guard: forward moves always apply; backwards moves only for an explicit release (CANCELLED/REJECTED/delete), so a stale HOLD can never drag a WON deal back. `create()` also gains a bookable-lead guard - the lead must be `NEGOTIATION`/`BOOKING_INITIATED`/`WON` (409 otherwise). Repair migration `20260915090000_lead_state_sync_repair` reconciles 3 stale rows with before/after audit rows. | architecture | P1,P5,P6 | `bookings.service.ts` never wrote `Lead.state` - zero references - so the two fields were independent and nothing reconciled them. Live dev DB showed 4 HOLD bookings on leads still marked `NEW` and an APPROVED booking on a lead still at `NEGOTIATION`: the leads page and the bookings page told different stories about the same deal, and an operator scanning leads could not see which customers had a villa on hold. Same failure class as #42 (hand-maintained duplicate state) but across modules, so the guard + mapping are explicit and unit-tested rather than inlined at each call site. The bookable-lead guard closes the mirror-image hole: a booking could be opened on a lead at NEW, skipping the entire sales process. | (A) A DB trigger like `unit_status_sync_booking` (#42) - rejected, `Lead.state` is not a pure function of bookings: the sales team owns most transitions (CONTACTED/VISIT_*/COLD/LOST) and a trigger would fight them; the sync must only fire on booking writes; (B) reuse `leads.state-machine.ts` directly - rejected, it is ROLE-aware (SALES_EXEC is limited to VISITED/NEGOTIATION/BOOKING_INITIATED, only ADMIN reopens terminal states) and a booking-driven write is a SYSTEM action - an exec who legitimately approves a booking must not be blocked because the machine reserves WON for a manager; (C) sync on read / compute a display status - rejected, `Lead.state` drives filters, the RLS lanes and the pipeline board, so it must be persisted; (D) let each caller set the state - rejected, that is exactly how the drift happened (and how the unit status drifted before #42) |
| 47 | Eng (2026-09-15) | **`auditlog_insert_any_authenticated` requires a non-null actor: booking-driven writes pass the real `userId`.** `syncLeadState` writes `userId: options.actor.sub` (the acting user), never `null`, with `action: 'lead.state_sync'` marking it as a system-derived write. | security | P1 | Found by the live end-to-end check, not by any mock: `userId: null` on the sync's audit row violated the RLS policy (`app.user_id IS NOT NULL`) and the whole transaction aborted with Prisma `P2039 - new row violates row-level security policy for table "AuditLog"`. Because the audit write shares the transaction, the booking transition failed too. Mocked tests could not express this - a mocked client has no RLS. | n/a - no alternative; the policy is correct and the row must name an actor |
| 48 | Eng (2026-09-15) | **T-INV-SYNC follow-up: the unit edit dialog renders a booking-owned status READ-ONLY and omits it from the payload.** `DERIVED_UNIT_STATUSES = ['HOLD','TOKEN']` + `isDerivedUnitStatus()` in `apps/web/src/lib/labels.ts`. When the unit's status is derived, `UnitEditFormBody` swaps the SELECT for a `type:'custom'` row (`data-qa="unit-edit-status-derived"`, "Set by this unit's booking. Cancel or reject the booking to free the unit.") and `handleSubmit` sends **no** `status` key, so the PATCH leaves `Unit.status` to the booking trigger. AVAILABLE/SOLD units keep the editable picker exactly as before. | bug | P1,P2 | Decision #42 narrowed the manual override to `AVAILABLE|SOLD` (`UpdateUnitStatusSchema`), but the dialog seeded its status picker from the unit's own current status (`status: unit?.status ?? 'AVAILABLE'`) and always submitted it. On a HOLD or TOKEN unit that produced `status: 'HOLD'`, which the controller's `parseBody(UpdateUnitDtoSchema, ...)` rejects with `400 body: status: Invalid option: expected one of "AVAILABLE"|"SOLD"` - so **every** save on a held unit failed, including pure price/BHK/sqft/facing edits. 3 of 22 dev units were affected (FA-001, FB-001, A-203); in a live project it hits most units as soon as bookings start. The picker also displayed a value its own option list cannot contain, which is a lie to the operator on top of the write failure. Verified live: DTO gate on the old payload FAILS, on the fixed payload PASSES, and a real `update()` on the HOLD unit now succeeds with `status` left at `HOLD`. | (A) Allow HOLD/TOKEN back into the DTO - rejected, it re-opens the drift #42 closed and lets a form contradict a live booking; (B) drop `status` from the edit dialog entirely - rejected, AVAILABLE/SOLD is a legitimate manual mark staff need; (C) keep the picker but silently send nothing when derived - rejected, the operator still sees a picker pre-set to a value they cannot choose; (D) let staff force AVAILABLE over a live booking - rejected by the user |
| 49 | Eng (2026-09-15) | **T-BOOK-LEADSYNC follow-up: every booking mutation now invalidates the lead caches.** `useUpdateBooking` / `useEditBooking` / `useDeleteBooking` previously only dropped the `bookings` + `inventory` keys - the `useCreateBooking` path was the only one that touched leads. Since #46 made a booking write move `Lead.state` server-side, the other three left the leads page/board showing the pre-booking state for the 5-minute `staleTime`. All four now funnel through one exported `invalidateBookingSideEffects(queryClient, bookingId?, leadId?)` (bookings + inventory + lead list + single lead). `useUpdateBooking`/`useEditBooking` read `leadId` from the response; `useDeleteBooking` can't (the row is gone) so the `['leads']` list invalidation covers the grids/board. New test `apps/web/src/hooks/queries/booking-cache-invalidation.test.ts` (this repo has no @testing-library/react, so it drives the exported helper against a real QueryClient). | bug | P1,P5 | The DB drift was fixed by #42/#46, but the CLIENT could still show it: bookings and inventory were invalidated on every write while the leads cache - now stale after #46 moves `Lead.state` - was only refreshed on create. On a HOLD→NEGOTIATION release the operator would see the lead stuck on its old state for up to 5 minutes. Cache invalidation is part of the derived-column contract, not an afterthought. | (A) refetch leads on every booking write - rejected, this is exactly what the fix does, scoped to the pages that read them; (B) shorten staleTime globally - rejected, hides it rather than fixes it and costs requests on every page |
| 50 | Eng (2026-09-15) | **T-INV-SYNC follow-up: a new unit cannot be created in a booking-owned status.** `CreateUnitDtoSchema.status` changed from `UnitStatusSchema` (full enum) to `UpdateUnitStatusSchema` (`AVAILABLE|SOLD`), and `InventoryService.create` throws a `ConflictException` on `HOLD`/`TOKEN`. Declared `UpdateUnitStatusSchema` above its first use to avoid a TDZ. | bug | P1,P2 | `POST /api/inventory/units` was the LAST way to put a unit into `HOLD`/`TOKEN` with no booking behind it. The trigger only fires on `Booking` writes, so such a unit stays stuck forever AND is permanently unbookable (the bookable-unit guard rejects a non-AVAILABLE unit) - a dead unit reachable through the API. `UpdateUnitStatusSchema.safeParse({status:'TOKEN'})` verified ACCEPTED before / REJECTED after. Mirror-inverse of #48 (edit dialog submitted the status; create accepted it) and of #39. | (A) leave the full enum on create - rejected, it restores the exact dead-unit hole; (B) recompute on read only - rejected, the grid filters use the persisted column |
| 51 | Eng (2026-09-15) | **Leads table: NEW-lead rows tint by age.** `leadAgeTier(row, now?)` + `LEAD_AGE_TIER_CLASS` in `apps/web/src/lib/leads.ts`; wired through the props-API `DataTable`'s `getRowClassName` on the leads page. Tiers: `<10 min` no tint · `10–<20` light yellow (`bg-yellow-50`) · `20–<30` dark yellow (`bg-yellow-200`) · `>=30` red (`bg-red-100`), each with hover + `dark:` variants. NEW-only, decided by the user. A `useAgingTick` heartbeat (`apps/web/src/lib/use-aging-tick.ts`, 30s, only armed when the page has a NEW row) re-renders the table so a row crosses a boundary while the operator is watching. | mechanical | P2,P5 | The leads inbox is worked from a single sorted table and the operator had to read `createdAt`/the Overdue badge per row to judge urgency. Colour makes the ordering visible at a glance. The tier boundaries deliberately reuse the existing `OVERDUE_AFTER_MIN = 30` so the red row and the "Overdue" badge can never disagree - the same threshold, one definition. NEW-only matches the existing SLA rule (`isOverdue`): once a lead is picked up the clock stops mattering (plan D25 non-goal - aging CONTACTED/NO_SHOW leads). Pure helper + injected `now` keeps the boundaries unit-testable; the page passes the value only. | (A) Tint every state by age - rejected by the user, and it would paint worked leads as urgent; (B) a colour dot in the Status cell instead of the whole row - rejected, the user asked for row colour and a whole-row tint is readable from across the table; (C) recompute from `Date.now()` in the cell without a timer - rejected, a row that goes stale while the operator watches would stay white until the next refetch - exactly when the tint matters; (D) `setInterval` inside the page component directly - rejected, an unguarded timer runs even on a fully-worked table and is harder to test than a named hook with an `enabled` flag |
| 52 | Eng (2026-09-15) | **Web test suite: pure-logic files opt out of jsdom.** A first-line `// @vitest-environment node` pragma on the 10 files that touch no DOM (`lib/{booking-roles,inventory-statuses,labels,leads,phone,nav,nav-project-routes,sse}`, `hooks/queries/{projects,booking-cache-invalidation}`). `apis/client.test.ts` stays on jsdom (it exercises `window.location`). | performance | P6 | A timed 61-file run showed the suite spends its time on per-file setup, not assertions: `import 357s` + `environment 80s` vs `tests 10s`. Vitest boots one jsdom per FILE, so pure-logic files paid the full cost for nothing. Result: `environment 79.76s → 60.12s` with all 61 files / 470 tests green - no config change, no behavioural risk, and the pragma is self-documenting at the file that needs it. | (A) Switch the global environment to `node` - rejected, ~45 files genuinely render React and would break; (B) `environmentMatchGlobs` in vitest.config - rejected, it splits the rule away from the files it governs and every new test file needs a config edit; (C) leave it - rejected, this is a per-invocation tax on every dev loop and every CI run |
| 53 | Eng (2026-09-15) | **Lead inbox default sort: within each bucket, order by MOST RECENT ACTIVITY (`updatedAt DESC`), not `createdAt DESC`.** `sortOrderSql` in `apps/backend/src/leads/leads.service.ts` now emits `... END) ASC, "updatedAt" DESC, "createdAt" DESC`. Buckets unchanged (0 overdue NEW -> 1 fresh NEW -> 2 rest). `createdAt DESC` kept as the final tiebreaker so equal-`updatedAt` rows stay deterministically ordered (bulk imports/seeds share a millisecond, and a non-total order lets server pagination drop or duplicate a row). 5 new tests in `leads.service.test.ts` pin the generated ORDER BY - nothing covered the default ordering before. | bug | P1,P2 | **Plan/code mismatch**: Decision 0.2 (line 20 + line 163, the plan of record) says the default sort is "Overdue first-touch -> New -> **Most recent activity**", and the table column the operator reads is titled "Last Activity" and renders `updatedAt` - but the code sorted each bucket by `createdAt`. Commit 0a9fc82 introduced the buckets with `createdAt DESC` and documented that choice in its own message, diverging from 0.2 without a decision entry. The user-visible effect: a lead worked five minutes ago sat below one that had merely been created more recently and never touched, so the order contradicted the value displayed beside it. Verified on live data: 7 rows change position, and the real `list()` now returns buckets ascending with `updatedAt` descending inside each (invariant checked across all 15 rows). | (A) keep `createdAt DESC` and reword Decision 0.2 - rejected, the overdue bucket and the "Last Activity" column both frame the inbox as an activity queue, so activity is the correct key; (B) order by `updatedAt` only - rejected, non-deterministic under equal timestamps and unsafe for server pagination; (C) add a visible default sort indicator in the toolbar - rejected, the DataTable's `sorting` prop is empty on purpose for the server default (a later task if the affordance is wanted) |
| 54 | Eng (2026-09-15) | **Booking detail page: each action button carries its own semantic icon.** New `STATUS_ICONS` map in `bookings/[id]/page.tsx` (one icon per `BookingStatus`, mirroring the `STATE_ICONS` convention in `components/shared/LeadActionPanel.tsx`) + a `BACK_ICON`. `TOKEN -> LuCircleDollarSign` (token payment), `APPROVED -> LuBadgeCheck` (signed off), `REJECTED -> LuCircleX` (refused), `CANCELLED -> LuBan` (released). The map is keyed on a new `BookingTransitionTarget = Exclude<BookingStatus, 'HOLD'>` type, and `LEGAL_NEXT`/`toStatus`/`onSubmit` were narrowed to it - HOLD is only ever a STARTING state (create() makes it; the backend legalNextStates() never returns it as a target), so it has no action icon and the type makes that unrepresentable. Applied to the offered-transition buttons, the confirm button (same glyph as the button clicked to get there), and "Back to bookings" (replaces the `←` text arrow). 7 new tests pin that each action has a DISTINCT glyph, that icons stay `aria-hidden` with the label as the accessible name, that no text arrow remains, and that HOLD is offered as a target from NO state. | mechanical | P2,P5 | Every non-approval transition previously shared ONE generic `LuArrowRight`, so "Token received" and "Cancelled" were visually identical - the destructive action had no warning cue at all, and the label was rendered as `"→ Cancelled"`, putting a text arrow inside the accessible name. The leads panel next door already uses semantic per-state icons, so the booking surface was the inconsistent one. | (A) keep one arrow icon and differentiate by colour only - rejected, colour alone fails for colour-blind operators and does not convey intent; (B) add a `leftIcon` prop per call site - rejected, three call sites would drift; a single map keyed by status keeps them in step and is testable; (C) use icons only with no visible label - rejected, the label is the accessible name and the actions are destructive |
| 55 | Eng (2026-09-15) | **T-BOOK-REASON: a booking cannot be CANCELLED/REJECTED without an operator-supplied reason.** New `TransitionReasonRequired` set in `packages/api-types/src/bookings.ts` (declared before its users); `BookingTransitionDtoSchema` is now a `z.object().superRefine()` enforcing a non-blank `reason` for those two targets, with the issue reported on the `reason` path. `BookingsService.transition` adds a matching `BadRequestException` guard. | bug | P1,P2 | The DTO's own doc comment claimed a reason was required for the release moves, but `reason` was merely `.optional()` and NO layer checked it - the UI check was a `toast` + early `return` in a click handler. Verified live against the dev DB: `transition({toStatus:'CANCELLED'})` with **no reason** succeeded, a whitespace-only reason succeeded, and the AuditLog stored the generated placeholder `Booking HOLD -> CANCELLED by owner@... (OWNER)` instead of a justification. A cancel is exactly the record someone reads back weeks later to explain why a deal died, so the missing reason is lost business context - the same gap the leads module has for LOST/COLD. | (A) leave enforcement to the UI - rejected, a stale client or a direct service call bypasses it entirely (and did); (B) `.refine()` on `reason` alone - rejected, the rule is cross-field (it depends on `toStatus`), so the zod v4 pattern is `superRefine` on the parent with an explicit `path`; (C) make `reason` required on the whole schema - rejected, HOLD->TOKEN and ->APPROVED legitimately need no reason and that would break the normal flow |
| 56 | Eng (2026-09-15) | **Booking detail page: the transition form is now the props-API `<Form>` + zod, not hand-rolled state.** `transitionSchema` (zod, `superRefine` for the conditional reason) drives a single `useForm` instance; the reason field is a declarative textarea field, the confirm button is `type="submit" form={FORM_ID}`, and the payload is built from the form's own validated `toStatus` so it cannot drift from what was validated. The old `useState` reason box plus the manual `toast` guard are gone. `BookingApprovalDialog` (the list-page twin) now reads the same `TransitionReasonRequired` set instead of re-encoding the rule. | mechanical | P2,P5 | User direction: "use proper Form component with zod validation for all input form". The hand-rolled version validated inside the click handler, so the rule lived only at that call site and surfaced as a transient toast rather than an inline field error; the Form version attaches the issue to the `reason` control and keeps one definition of the rule across the DTO, the service and both dialogs. It also drops a `<Label>`/`<Textarea>` pair the props-API Form already renders. | (A) keep the hand-rolled box and just add zod - rejected, half a change: the failure would still appear as a toast, not on the field; (B) extract a shared `BookingTransitionForm` component - deferred, the two surfaces have different affordances (badge header + icon confirm vs a decision select) and the logic that actually needed sharing is now the schema + `TransitionReasonRequired` |
| 57 | Eng (2026-09-15) | **Booking confirm step: "Move from X to Y" renders ABOVE the reason textarea.** The confirm step was extracted from the booking detail page into its own component - `apps/web/src/components/bookings/BookingTransitionConfirmStep.tsx` - and the context row now comes before the `Form`. 6 tests in its own `*.test.tsx` pin the order, the required/optional flip, and the submit wiring. | mechanical | P2,P5 | User direction: "Make sure move from comes first and then reason note textarea second". The props-API `Form` had been rendered before the badge row, so the operator was asked to justify a transition before being shown WHICH transition it was. The order was also unassertable while the block lived inline in the page: a static render only ever shows step 1 (the offered-action buttons), and step 2 requires a click that this repo's render-only test setup cannot perform. Extracting the block makes the order directly testable - verified by swapping the two blocks, which turned the order test red, then green when restored. | (A) leave it inline and test the page - rejected, unreachable in a static render; (B) export the block from `page.tsx` for tests - rejected, Next.js's generated page type-check rejects extra named exports from a page module (caught as `OmitWithTag ... does not satisfy` on the `.next` types), so a test-visible block cannot live in a page file at all; (C) assert order via a DOM-level test with a click - rejected, the repo has no `@testing-library/react` |
| 58 | Eng (2026-09-15) | **After creating a booking, redirect to the BOOKINGS LIST, not the parent lead's page.** New pure helper `afterBookingCreateHref(orgSlug, projectSlug)` in `apps/web/src/lib/bookings.ts`; `bookings/new/page.tsx` now pushes it on success and the dead `CreatedBooking` type plus the id-based branch are gone. 4 tests in `lib/bookings.test.ts` pin the destination. | bug | P1,P2 | User direction: "After booking created, page needs to redirect to booking list page not lead specific page". The happy path pushed `/leads/:id` (mirroring the leads form, which correctly redirects to the created LEAD) while only the no-id FALLBACK went to `/bookings` - so in practice the list was almost never reached. A lead page renders no booking panel at all, so creating a booking looked like a no-op: the operator landed on a page with no trace of what they had just made. Verified by restoring the old target: all 4 tests go red. | (A) push `/bookings/:id` (the new booking's detail page) - rejected as the default, the user asked for the list and a create that immediately changes surface into a detail view loses the "did it work, and what else is here" context; (B) inline the `/bookings` literal in the page - rejected, that is exactly the untestable shape that let this bug through, since the branch only runs inside a mutation callback with no `@testing-library/react` in the repo; (C) keep the id-based branch and only swap the target - rejected, both arms then point at the same place, so the branch was dead weight |
| 59 | Eng (2026-09-15) | **The mustChangePassword gate is DISABLED by default; the feature itself is kept.** `User.mustChangePassword` default flipped `true -> false` in the Prisma schema; seed writes `false`; migration `20260915140000_disable_must_change_password` sets the column default to false AND resets existing rows (56 migrations, applied). Verified live: 0 of 838 users armed, and a freshly created user now lands unGated. | config | P2 | User direction: "Disable mustChangePassword to false. Don't remove page or logic." The gate forced every seeded operator through /change-password on first sign-in - friction that is no longer wanted now that the CRM is being demoed and used day-to-day. Chosen shape: flip the DATA default rather than delete the check, so /change-password, the guard's check, `UsersService.changePassword`'s flip-to-false write and the BFF's 403 handler all remain intact and a single user can still be gated by setting the column to true. | (A) delete the guard check - rejected by the user and by judgement, it removes a working security control for a friction problem; (B) exempt specific emails in the guard (as the demo user was) - rejected, it grows an allowlist in code for what is really a data default; (C) set the flag false only in the seed - rejected, existing rows and any non-seed signup path would stay gated |
| 60 | Eng (2026-09-15) | **Prisma client must be regenerated after a schema-default change - the DB default alone is not enough.** `prisma generate` is required or the client keeps sending the OLD default on create. | bug | P1 | Found by verifying the change instead of trusting it: after `migrate deploy` the DB column default read `false`, yet a newly created user still came back `mustChangePassword: true`. The Prisma client serialises the schema's default into its create path, so a stale generated client silently overrode the database. `schema.prisma` says `false` and `information_schema` says `false`, but the insert still wrote `true`. Re-running `prisma generate` fixed it (new user -> `false`). Lesson: `migrate deploy` changes the DATABASE; it does not rebuild the client that ships the defaults. Always `generate` after editing a `@default`, and verify by CREATING a row rather than reading the column metadata. | n/a |
| 61 | Eng (2026-09-15) | **The mustChangePassword gate applies to the OWNER only.** `seed.ts` arms it via `mustChangePassword: role === 'OWNER'`; migration `20260915160000_must_change_password_owner_only` sets the flag true for OWNER rows and false for every non-OWNER row. Column default stays `false` (API-created users are never OWNER, so they start ungated). Verified live: `owner@shadhilbuilders.in` gated, all 852 other users clear. | config | P2 | User direction: "Only make role owner must change password". Re-scopes #59, which had disabled the gate entirely. OWNER is the one role with unrestricted privileges, and it is also the only role that cannot be created through the API (`assertCanCreateRole` rejects an OWNER target - "exactly one exists via seed") nor reassigned into, so the seed is its sole writer and arming it there is sufficient. | (A) keep the gate off entirely (#59) - superseded by this decision; (B) gate ADMIN too - rejected, it is a shared/operational account and the friction is what #59 removed; (C) enumerate exempt emails in the guard - rejected, a code allowlist for what is really a per-role data rule |
| 62 | Eng (2026-09-15) | **The demo user becomes the OWNER of its own isolated organization (`demo`), with its own seeded data.** `setup-demo-user.ts` rewritten: it upserts the demo `Organization`, an OWNER-role `demo@shadhilbuilders.in` inside it, and that org's own team/project/phases/units/leads/chat/notifications/bookings. Migration `20260915180000_demo_org_separation_repair` repairs what the old script left in the real org: 11 real leads rehomed to `admin@`, and the leftover "Demo Team" repointed to a real org member. The three e2e specs now use the demo org's slug paths (`/demo/projects/demo-villas/...`). | architecture | P1,P2,P5 | User direction: "I want demo user needs to owner but different org". A different org is the ONLY legal shape, not a preference: `User.organizationId` is single-valued (no membership table) and the DB enforces `one_owner_per_org UNIQUE (organizationId) WHERE role = 'OWNER'` - so a second OWNER cannot coexist with the bootstrap org's owner. **The old script was also actively harmful**: it ran `lead.updateMany({ where: { id: { not: { startsWith: 'test-' } } } })`, reassigning ~120 REAL leads to the demo user and a throwaway team; that is removed. Verified live: real org 121 leads / 22 units intact, demo org 6 leads / 5 units, ZERO leads whose owner sits in another org, and both orgs hold exactly one OWNER. | (A) make the demo user an OWNER inside the bootstrap org - IMPOSSIBLE, the `one_owner_per_org` index rejects it; (B) keep the demo user a MANAGER (today's state) - rejected by the user's requirement; (C) reassign the real org's leads into the demo org - rejected by the user: another tenant's data must not be moved to a demo account; (D) leave the old script's reassignment and just swap the org - rejected, it would strip the real org's lead ownership; (E) delete the now-unused "Demo Team" - rejected, `Lead.teamId` is NOT NULL and the rehomed leads still reference it, so the team is repointed rather than removed |
| 63 | Eng (2026-09-16) | **The lead row-tint tests assert the tier's own classes, not hardcoded Tailwind shades.** `page.test.tsx` reads `LEAD_AGE_TIER_CLASS[tier]` and extracts its `bg-*` utility, plus a new case asserting the three windows produce three DISTINCT backgrounds. | mechanical | P6 | The overdue red was tuned `bg-red-100` -> `bg-red-200` on 2026-09-16, which failed a test that pinned the literal. A test coupled to a design constant breaks on every colour tweak while proving nothing about the tiering it exists to protect. Now the source of truth is the single map, and the new distinctness case catches the failure that actually matters - the staircase collapsing onto one colour (verified: forcing all three tiers to the same class turns it red). | (A) update the literal to `bg-red-200` - rejected, it re-arms the same brittleness for the next tweak; (B) drop the shade assertions entirely - rejected, then nothing proves the tier reaches the row; (C) snapshot the row class - rejected, a snapshot fails on any unrelated class change and invites blind re-recording |
| 64 | Eng (2026-09-16) | **T-DASH-KPI-COLUMN: the four dashboard counts STACK into a column on a phone and return to four-in-a-row from `sm` (640px), with NOTHING hidden on a card.** `KpiStrip` is `grid-cols-1 sm:grid-cols-4`; the card keeps one stacked shape at every width (label, value, sub-line, filter affordance all visible) and only padding and value type respond. **Supersedes an earlier owner ruling ("keep all four counts on one row at 320px")** - that ruling existed to keep the queue above the fold, and two of its assertions (here plus `dashboard-audit.spec.ts`) were updated rather than deleted. | taste | P1,P3 | Owner direction 2026-09-16, twice refined: "make kpi card rows into column for mobile view" then "don't hide anything for kpi card in mobile, just make it responsiveness". The one-row rule was itself a fix for a CLIPPED label (uppercase + tracking-wide needed four lines in a 66px card), so the cause was the card width, not the row count - stacking removes the cause. Each stacked card is also a full-width 44px tap target, which a 66px column could never be. Cost, measured and accepted: four full cards are ~500px tall, so on a 568px phone the queue now starts BELOW the counts (~712px). The queue was previously at 448px, and the per-role page ORDER (visits-first for a sales exec, queue-first for telecaller/manager) is kept, but a "queue above the fold at 320px" invariant is no longer achievable without hiding part of a card - which was explicitly ruled out. Recorded rather than silently dropped. | (A) keep four-on-one-row and shrink the label - rejected, the owner asked for a column twice and shrinking type trades a clipped word for an unreadable one; (B) stack AND hide the sub-line/affordance on mobile - rejected, that is the exact behaviour the owner told me to stop; (C) add a 480px tier to get 2-up on a phone - rejected after MEASURING it wrong twice: `min-[30rem]:` is an arbitrary-value media query that sorts AFTER the named breakpoints and so beat `sm:grid-cols-4` at 844px (landscape phone + tablet rendered 2-up), and a custom `@theme { --breakpoint-xs }` is emitted at its own position rather than sorted between `base` and `sm`, so it still won at 844px. Dropping the tier removes the trap and still stacks on a portrait phone, which is where stacking was asked for |
| 65 | Eng (2026-09-16) | **`prettier-plugin-tailwindcss` is now an installed devDependency of `apps/web`.** `pnpm format` and `format:check` had been SILENTLY DOING NOTHING: `apps/web/prettier.config.js` declares `plugins: ['prettier-plugin-tailwindcss']`, the package was neither installed nor in the lockfile, and Prettier errored (`Cannot find package`) while `--check` still exited 0. | mechanical | P1,P5 | A checker that cannot fail is worse than no checker - it reports success while formatting nothing, so every "formatting is clean" signal in this repo was meaningless. Verified the tool is live after installing: an intentionally unformatted file now FAILS `--check` with exit 1 and a clean file passes. Installing it reveals the repo was never formatted with it: 209 files fail the sort-order check, 178 of them untouched by any of this work, which is why I formatted only the files this changeset creates rather than the whole tree. | (A) leave it uninstalled and drop the `plugins` key from the config - rejected, it changes the project's declared formatting intent to match a broken install; (B) install it and reformat all 209 files in this changeset - rejected, it would bury the client-facing dashboard changes under a repo-wide whitespace diff; (C) leave the config as-is - rejected, that is the status quo that silently no-ops |
| 66 | Eng (2026-09-24) | **Booking approval narrowed to ADMIN/OWNER: MANAGER revoked.** `BookingsService.transition()` drops the `actor.role !== 'MANAGER'` exemption (now `!isAdminClass(actor.role)`), and web `canApproveBookings()` becomes `isAdminLike()` only, so Approve/Reject disappear from the booking detail Actions card, the bookings row menu, and the dashboard approvals queue for non-admins. `DESIGN.md` §3 (Manager/Sales Exec rows), the module-6 row and the §4 matrix were updated in the same change. Cancel and HOLD → TOKEN are untouched. | security | P1,P5 | Owner direction: approving a booking is an admin/owner act, not a manager one - the same class as T-BOOK-ROLES (#43), which had left MANAGER in place because the matrix then said ✅ "in team". AGENTS.md makes the plan the spec, so the code and the matrix had to move together rather than drift. Both outcomes are gated (APPROVED *and* REJECTED - rejecting ends the deal and is the same decision). RLS was deliberately NOT touched: role rules stay in the service (`references/authorization-role-gates.md`), and `booking_write_admin` is already ADMIN-only at the row level. | (A) Widen RLS to carry the role rule - rejected, it would grant cross-team writes and conflate row scope with action permission; (B) hide only the buttons in the detail page - rejected, the list row menu and the dashboard approval queue would still offer a control the API 403s; (C) hide the entire Actions card from non-admins - rejected by the owner as too broad, it would revoke Sales Exec's specified booking initiation and leave nobody but admin/owner able to Cancel; (D) leave the matrix alone and change only the code - rejected, the next reader would re-derive ✅ Manager from the spec |
| 67 | Eng (2026-09-24) | **`LeadState.COLD` renamed to `RNR` (pure rename).** New migration `20260924120000_rename_lead_state_cold_to_rnr` runs `ALTER TYPE "LeadState" RENAME VALUE 'COLD' TO 'RNR'`; `schema.prisma`, `api-types` (`LeadStateSchema`), seed, the backend state machine + role lanes, the web mirrors (`leads.ts`, `labels.ts`, `queue-actions.ts`, `LeadActionPanel`, `LeadStatusBadge`) and two raw-SQL `NOT IN (...)` queries in `dashboard.service.ts` all move with it. Friendly label becomes "Unresponsive". | mechanical | P5,P6,P1 | Client-facing terminology: the team calls this state RNR. Meaning and transitions are UNCHANGED (2+ consecutive no-shows -> terminal, manager reviews) - this is a label rename, not the call-centre "Ring No Response" concept, and the migration comment says so explicitly. `RENAME VALUE` was chosen over ADD VALUE + data-UPDATE because it rewrites the label in place: no row rewrite on a live table, no data-copy step to fail, ordering preserved (ADD VALUE appends, which would change `ORDER BY state`), and no orphaned 'COLD' label left for the API's closed-enum validation to reject on read. | (A) Edit the already-applied init migration in place - rejected, the DB holds real data and the journal would desync, so Prisma drift detection would "repair" it with another migration; (B) ADD VALUE 'RNR' + `UPDATE "Lead" SET state='RNR'` + leave 'COLD' - rejected, writes the table, bypasses the state machine and its audit rows, and strands a dead enum label; (C) recreate the enum type - rejected, requires dropping/re-adding every dependent column and constraint on a live DB; (D) also restyle the `RNR` state's icon to match the new name - DONE in the same change: `LuSnowflake` (a pun on "Cold") became `LuMoon` in `LeadActionPanel.STATE_ICONS`, channel-neutral because leads reach this state from failed calls, WhatsApp and no-show visits alike |

| 68 | Eng (2026-09-25) | **T-WA-INBOX: a WhatsApp chat system for MANAGER/ADMIN/OWNER.** New page `/{orgSlug}/projects/{projectSlug}/whatsapp-chat`, WhatsApp-Web-style two panes (conversation list left, chat panel right, panel switches on selection). Kept **ONE message table**: `Message.leadId` becomes **nullable** + new `Message.contactId` FK (a CHECK enforces exactly one thread per row), plus `OutboundMessage.contactId` and a new `ChatReadState` model (per-USER lastReadAt). Unknown inbound numbers now persist a real `Message` row (migration `20260925100000_wa_inbox_threads_and_read_state`) instead of being discarded after bumping `WhatsappUnknownContact.messageCount`; the counters are kept because the triage queue sorts on them. Replies call a new `sendToContact` which writes `Message(direction=OUT, channel=WHATSAPP)` and enqueues a FREEFORM outbound in ONE transaction; `outbound.service` gained a thread-aware `threadPhone` resolver. RLS: 8 new org-scoped policies for `leadId IS NULL` + `ChatReadState` ENABLE/FORCE RLS (message access was previously enforced ONLY through a `Lead` join, so nullable `leadId` silently opened every contact thread). `canReply` (which actually meant "has a phone number", not "inside the reply window") was removed rather than shipped mislabelled. | mechanical | P1,P5,P6 | A manager cannot currently answer a WhatsApp customer: inbound is stored but there is no surface to read or reply from, and an unknown number's messages were thrown away (a manager saw "5 messages from this number" and nothing else). Three gates keep it MANAGER+: nav visibility, a page-level re-check, and a backend 403 - it exposes conversations for the active project, so it is deliberately NOT opened to TELECALLER/SALES_EXEC, who keep their per-owner lead chat panel. | (A) auto-create a `Lead` per unknown inbound - rejected, reverses T-E2b and pollutes the pipeline with unqualified numbers; (B) a separate `Conversation` table - rejected, needs a data migration and breaks the `Message.leadId` contract that RLS, the outbound cron and the existing chat pane all read; (C) make `leadId` nullable WITHOUT new RLS policies - rejected, it would expose every contact thread to every role because `message_select_team` scopes rows via `EXISTS(... FROM "Lead" ...)`, which is vacuously true for a NULL `leadId`; (D) reuse the `Combobox` for the list filter - rejected, four fixed modes are better as visible chips and the Base UI portal is not automatable in this repo |
| 69 | Eng (2026-09-25) | **The inventory grid lists units on-hold first, then available, then token/sold.** `InventoryService.list()` no longer returns rows in `phaseId, unitNumber` order: it ranks each status through a new `unit-status-rank.ts` (`HOLD 0, AVAILABLE 1, TOKEN 2, SOLD 3`) and keeps phase/unit number as the tie-break inside a status. The rank map is the single source of truth, and a test asserts every `UnitStatus` in the Prisma enum is ranked. | mechanical | P2,P6 | The villa grid is the surface a manager scans to answer "what can I still sell?", and the old alphabetical-by-phase order buried the few units needing attention (holds and tokens) among dozens of open ones - on the real project, 1 hold sat eleventh of sixteen. On-hold first puts the units blocked mid-deal at the top where staff see them without scrolling. Sorting happens in the BACKEND, not the grid: the list is server-paginated (page size 10 of 16 units), so a client-side sort would reorder the loaded page and scatter the remainder across the wrong pages - the same class of bug the repo already bans for filters. | (A) `orderBy: { status: 'asc' }` - rejected, Prisma sorts a Postgres enum by DECLARATION order (AVAILABLE, HOLD, TOKEN, SOLD), which is near the reverse of the requirement and cannot express a custom sequence; (B) a hand-built `$queryRaw` ORDER BY with a CASE expression - worked when trialled against the live DB, but rejected because it requires re-deriving the WHERE clause by hand, and the first attempt silently dropped every filter (it emitted a bare `TRUE`), so the grid would have shown all units regardless of the phase/BHK/facing filters; the chosen approach reads the sort keys through Prisma, ranks them, then hydrates the page by id, leaving filter handling exactly as Prisma builds it; (C) sort in the browser with a TanStack `sortingFn` - rejected, it breaks on pagination and every column is already `enableSorting: false`; (D) rank `TOKEN` with `HOLD` at the top - rejected, a token unit is not blocked, it is further along than an open one, so it sits after `AVAILABLE`; zero token units exist today so the choice is invisible in current data but the order is defined rather than incidental |
| 70 | Eng (2026-09-25) | **The backend vitest suite gets a 30s test/hook timeout, set in `vitest.config.ts` rather than per test.** Two suites failed intermittently in the full run (`users.service.test.ts`, `visits.service.test.ts`) on vitest's 5s default; the ceiling is now 30s for every test in `apps/backend`, matching `packages/database/vitest.config.ts` which already did this. | config | P6,P5 | The failures were never a regression: the same tests pass in isolation and on rerun, and the FAILING TEST NAME changes run to run (OWNER-reset at 10806ms, then VISITED-baseline at 8490ms, then happy-path at 19691ms) - the signature of a load-sensitive timeout. Root cause is real work colliding with a parallel run: `changePassword` tests run genuine scrypt (N=16384, r=16 - a ~33MB synchronous allocation each, and `scryptSync` blocks the event loop), and the DB-backed suites do several `withRlsContext` round-trips each, all while 51 files compete for one worker per core and share the connection pool with the running dev server. Reproduced deliberately by reverting to the 5s default and running the full suite concurrently with `pnpm type-check` and `pnpm lint`: the happy-path test landed at 19691ms and failed. With the 30s ceiling the same three-run experiment was green 3/3. | (A) raise the timeout on just the two failing tests (the repo's own precedent in `9a8f5e3`, which patched two `overdue-alerts` tests to 30s) - rejected as the primary fix, because the failing test is not stable: whichever heavy test loses the CPU race fails, so a per-test patch fixes today's name and leaves the next one red; the config ceiling covers every test including ones added later; (B) reduce parallelism (`fileParallelism: false` / `singleFork`) - rejected, it would slow every full-suite run for a problem that only needs headroom, and `packages/database` already keeps its single-fork pool setting for DB-isolation reasons unrelated to timeouts; (C) make the tests faster by stubbing scrypt - rejected, `changePassword`'s scrypt cost is the thing under test (it proves the real credential path), and the DB suites have nothing to stub; (D) leave the flake and re-run until green - rejected, a suite that fails at random trains people to ignore red |
| 71 | Eng (2026-09-25) | **The inventory grid gets a "Search by villa" box, searching the villa number server-side.** `UnitFilterDtoSchema` gains `search` (trimmed, 1-120 chars); the controller forwards it explicitly; `list()` adds a case-insensitive `contains` on `unitNumber` as a top-level `OR`; the page debounces 300ms and requires >= 2 chars, per the leads/users grids. | mechanical | P2,P6 | Staff hold a villa number (off a booking sheet, a brochure, a customer's message) and had no way to find it: the grid paginates 10 at a time across 16+ units in a single project, so locating one villa meant paging and scanning by eye. | (A) filter client-side over the loaded page - rejected, the same server-driven rule the repo already enforces for filters and sorting: it would search 10 of 16 rows and report a false miss for a villa sitting on page 2; (B) search the villa number AND phase/project name - rejected, a manager looking up 'A-103' wants that villa, not every unit in phase A, and widening the term makes the common case noisier; (C) a single-character minimum - rejected, 'A' matches 7 of 16 units and a 1-char query is not a lookup; (D) rely on the DataTable's built-in client-side search - rejected, it filters only the loaded page (and see the trap below) |
| 72 | Eng (2026-09-25) | **`DataTable`'s `search.accessorKey` must be given TWO entries (repeat the same column) or the search filters CLIENT-side and silently trims the server's page.** The inventory grid passes `accessorKey: ['unitNumber', 'unitNumber']` plus `globalFilterFn={() => true}`; a page-source test pins both. | bug | P1,P6 | Found by verifying the live grid instead of trusting a green suite: with the natural single-key form, searching "A" rendered **3 rows while the pagination total still read "of 16"** - the page contradicting itself with no error. Reading the library bundle shows why: `accessorKeys.length === 1` routes to `table.getColumn(k).setFilterValue(...)`, a TanStack **column** filter, which `globalFilterFn` does NOT govern; two or more keys route to `table.setGlobalFilter({...})`, which the no-op `globalFilterFn` then neutralises. `admin/users` and `UserLeadsCard` avoid the trap only by accident - they happen to list two real columns - so the single-key case was never exercised. | (A) keep one key and add an `onColumnFiltersChange` handler that clears the filter - rejected, it fights the library on every keystroke and breaks the moment the library changes its routing; (B) drop the DataTable search prop and hand-roll an Input - rejected, it loses the shared toolbar layout, the reset affordance and the accessible markup, for a one-line workaround; (C) list two REAL columns - rejected, it widens the client-side filter past what the server searched (searching 'A-103' would also match every unit in a project named 'A-103...'), so the repeat keeps the filter equivalent to the server's single-column search |
| 73 | Eng (2026-09-25) | **The inventory status filter becomes a `Select` (single value, `ALL` sentinel), replacing the multi-select `Combobox`.** `statusFilter` goes from `string[]` to `string`, its options gain a leading `{ value: 'ALL', label: 'All statuses' }`, and the filter is re-wrapped as `[statusFilter]` for the API. | mechanical | P2,P6 | All four toolbar filters now look and behave identically: the three beside it (phase/BHK/facing) were already single-value `Select`s with an `ALL` option, so the status control was the odd one out - a different trigger, a different chip/overflow rendering, and a different interaction for no functional gain. Nothing was lost: the Combobox was `maxSelectedChips={1}`, i.e. it already behaved as a single choice while presenting an empty-array no-filter state that no other filter shared. The backend is unaffected - `UnitFilterDtoSchema.status` accepts a single `UnitStatus` OR an array, and the hook still sends `status=HOLD`, so the wire contract does not move. | (A) keep the Combobox and only restyle it to match - rejected, the difference is behavioural (multi-select affordance, chip layout) not cosmetic, and the two still diverge on how 'no filter' is represented; (B) make the other three multi-select too - rejected, phase/BHK/facing genuinely are single-choice (a unit has ONE phase, ONE BHK, ONE facing) so multi-select would only invite impossible combinations and widen an already-fixed result set; (C) leave an empty-string value for 'no filter' - rejected, every sibling uses the `'ALL'` sentinel and the filter object already tests against it (`!== 'ALL'`), so a second representation would be the next inconsistency |
| 74 | Eng (2026-09-28) | **Auto-assign routes NEW leads to TELECALLERs only; with no eligible telecaller the lead goes to the creating team's MANAGER (never a sales exec).** `LeadsService.resolveAutoAssign()` filters the project pool with `role: 'TELECALLER'` on `User` and returns the manager-owned `manager-owner` resolution for every no-telecaller exit (empty project-team set, no members, no telecaller member, every telecaller at weight 0) - the same path the `autoAssignLeads=false` flag already used. The `managerOwned()` helper serves both, and the rule-chain fallback now applies only to a MANAGERLESS team. `ownerType` is `MANAGER` or `TELECALLER`. Web: only TELECALLER roster rows get the weight editor; a sales exec row shows "Not auto-assigned" instead. | bug | P1,P5 | Reported from live use: sales execs were taking brand-new first-touch leads. The pool had always been built from `role !== 'TELECALLER' && role !== 'SALES_EXEC'` and scored `openLeads / weight`, so an idle exec scored 0.0 and beat every working telecaller - the worst case being the execs with the least to do. Plan §3 is explicit that NEW..VISIT_SCHEDULED is telecaller-owned (an exec owns from VISITED onwards, via handoff or manual reassign), so an automatic exec pick contradicted the ownership invariant rather than merely being unfair. Owner direction on the empty-pool case: hand to the manager, do NOT let the exec tier win. | (A) tier the pool (telecallers first, sales execs only when no telecaller is eligible) - chosen first, then REVERSED by the owner: it still let an SE take first touch on an SE-only project, which is the same class of wrong-owner lead; (B) leave the pool shared and rely on weights to keep execs loaded - rejected, weight is an admin-set preference, not a role gate, and a default weight-1 exec at 0 leads still won; (C) exclude sales execs by dropping their `TeamMember` rows - rejected, that column also drives team membership, roster display and the removal/reassignment flows; (D) fall straight to the rule chain on an empty telecaller pool - rejected, an auto-assign team with no rules configured would then land the lead on the ACTOR (`fallback`), which is an admin, i.e. a lead owned by somebody who cannot work it |
| 75 | Eng (2026-09-28) | **The same telecaller-only rule now also covers the deterministic rule chain on lead-create, via a new `AssignmentMode` on `evaluateAssignment`.** `evaluateAssignment(..., mode: AssignmentMode = 'new-lead' | 'any')` and its service mirror `resolveOwnerFromEngine(..., mode)` skip any rule whose target is a SALES_EXEC when `mode='new-lead'` (walking on to lower-priority rules), and reject a sales-exec `Team.defaultAssigneeId` the same way; `create()` passes `'new-lead'`. The default `'any'` preserves the previous wider contract for callers whose own rules named the target, and `canUserBeAssignedTo` stays role-widest so the rule form can still record an exec target. Schema: a comment on `ManagerAssignmentRule.targetUserId` records that role is deliberately unconstrained at write time. | bug | P1,P5 | Gap left open by #74: with no eligible telecaller AND a managerless team, create fell through to the rule chain, which happily auto-routed a NEW lead to a sales exec (rule target or team default). Same defect, different door - the owner's "fill both gaps" named it explicitly. Restricting at CREATE time rather than at rule-write time keeps the operator's intent on file (an exec-handoff rule remains valid) while making first-touch ownership a hard invariant of the create path. Skipping-and-continuing, not aborting, is deliberate: a team with an exec rule at priority 1 and a telecaller rule at priority 5 should route to the telecaller, not dead-end on the actor. | (A) reject sales-exec targets in the rule form / `canUserBeAssignedTo` - rejected, it deletes a legitimate intent (an exec rule that a wider-mode caller such as reassign may honour) and would break existing rules on write; (B) hard-abort the chain on the first exec rule - rejected, it throws away a lower-priority telecaller rule that is exactly what the lead needs; (C) fix it only in `resolveAutoAssign` by making a managerless team fall back to a rule chain already filtered elsewhere - rejected, that is where the gap was, and the filter has to live in the chain itself to cover the `assignedOwnerId`-free branch; (D) make `evaluateAssignment` always telecaller-only - rejected, the manual-reassign path needs the wider set and a silent narrowing there would break exec handoff |

| 76 | Eng (2026-09-28) | **`TeamMember.maxOpenLeads` adds a hard per-member ceiling on open leads for auto-assign.** New nullable column (`Int?`, migration `20260928120000_team_member_max_open_leads`); `AutoAssignCandidate.maxOpenLeads` and a `withinCap()` gate in `pickAutoAssignCandidate` filter any member with `openLeads >= maxOpenLeads` out of the pool BEFORE scoring; `resolveAutoAssign()` selects the column and resolves it across memberships to the most permissive value. A capped-out pool returns `no-eligible`, which the create path already turns into the manager-owned pending handoff. Exposed as `PATCH /api/teams/:teamId/members/:userId/cap` (same ADMIN/OWNER-or-team-manager gate as `/weight`, audit `team.member.cap` in the same transaction), on the roster response, and as a `Max open` field beside `Weight` in the roster and weight dialog (blank = no cap). | feature | P1,P5 | Owner asked directly: "what happens when all telecaller weights are exceeded?" They are not - weight is a divisor, so it only ever redistributes share and nobody is ever "full". A capacity guarantee needs its own field, and conflating it with weight would be wrong in both directions: weight answers "among those who can take this lead, who?", the cap answers "can they take it at all?". Opt-in via NULL keeps every existing row byte-identical in behaviour, and the ceiling falls through to the manager rather than silently exceeding itself or handing work to a sales exec. | (A) treat `weight` as a cap once a member is "over" it - rejected, the ratio has no threshold to compare against, and any chosen one would silently change existing routing; (B) default the column to 0 and let admins raise it - rejected, 0 is a meaningful "send nothing" ceiling, so every member would stop receiving leads the moment the migration landed; (C) reuse the removal/reassignment overflow path - rejected, it is a destructive reassignment flow, not a routing decision; (D) let the pool keep the least-loaded member when everyone is capped - rejected by the owner, who chose the manager handoff so a human decides who takes the overflow |
| 77 | Eng (2026-09-28) | **The `shadhil-crm-dev` skill's SKILL.md exceeded its 100k limit and is now 90.6k.** The inline "PWA / Serwist quick reference" section (1.1k) was already superseded by `references/pwa-deployment-pitfalls.md`, so its content moved there and SKILL.md keeps a five-line pointer; the new `createDirectPrismaClient` / SELECT-only-fixture lessons went to `references/rls-policy-authoring.md`, and the parallel-DB-suite false-red trap to `references/test-verification-traps.md` + `references/known-runtime-bugs.md`. | docs | P5,P6 | The skill had been silently over budget: every `skill_manage` write was rejected, so lessons learned were going unrecorded. Same class as a checker that cannot fail - the store looked healthy while refusing all writes. | (A) delete older sections outright - rejected, they are still load-bearing for their triggers; (B) leave it and keep lessons in memory - rejected, they are procedural and belong with their task |

| 78 | Eng (2026-09-28) | **The dashboard's "Today's visits" card now labels BOTH identities: `Owner` (the lead's owner, the same field the lead page shows) and `Visit exec` (the person conducting the visit).** `VisitsService.VisitRow` gains `leadOwnerName`, selected from the parent lead's `owner` relation at all six row-building sites; `TodayVisitsCard` renders the two names side by side, owner first, and never falls back from a missing owner to the exec's name. Two comments that called the visit's exec the "owner" were corrected (`site-visit-calendar.tsx`, and the card's own header). | bug | P1,P5 | Reported as "owner name of lead was mismatch in dashboard and leads specific page". It was not a data defect: the card printed `userName` (the visit's exec) bare, while the lead page prints `Lead.ownerId`. Plan §3 keeps the TELECALLER as owner through VISIT_SCHEDULED while a SALES_EXEC conducts the visit, so the two surfaces showed two different, correct people with nothing on screen explaining why - the owner's own §3 rule made the card look wrong. Labelling both is the only fix that removes the ambiguity rather than moving it. | (A) print the lead's owner only - rejected by the owner, it hides the exec, which is the actionable name for "who is conducting this today"; (B) keep the exec but prefix it - rejected, the label alone still leaves the reader comparing two unlabelled concepts across pages; (C) rename the field to `execName` and leave the UI alone - rejected, the UI is what the operator reads |
| 79 | Eng (2026-09-28) | **FIXED: a SALES_EXEC can now see the `Lead` their own visit belongs to.** Before, the exec could read the `SiteVisit` assigned to them and NOT its parent `Lead`: `lead_select_telecaller` admits TELECALLER/SALES_EXEC only when `ownerId` OR `coOwnerId` = `app.user_id`, and on a VISIT_SCHEDULED lead the owner is the TELECALLER. Plan §3's "shared visibility" mechanism is exactly `Lead.coOwnerId` (schema comment: "For VISIT_SCHEDULED shared visibility") - and nothing ever wrote it. Consequence was worse than a null name: `lead_update_telecaller` gates UPDATE on owner-OR-co-owner too, so the exec could not record the outcome of their own visit at all (RLS 42501) - the visit could never be completed by the person who conducted it. `VisitsService.grantExecLeadVisibility()` now claims the co-owner slot for the conducting exec on `create` and on `reschedule`, narrowly: SALES_EXEC only (a MANAGER/ADMIN assignee already reaches the lead through their own policy), skipped when the assignee already owns or co-owns, never clobbering an unrelated co-owner (it throws `ConflictException` instead), and transferring the slot when `reschedule` moves the visit from one exec to another - the slot follows the exec actually conducting the visit. Audit `after.execLeadAccess` records whether a schedule granted access. | security | P1,P2,P8 | Proven against the live schema with the RLS-enforced role: `sitevisits_visible_to_exec = 1`, `parent_lead_visible_to_exec = 0`. The suite could not catch it because its fixture made `Lead.ownerId` and `SiteVisit.userId` the same user - the same root cause as #78, so both are one fixture defect. | (A) widen `lead_select_telecaller` to admit an actor with a visit on the lead - rejected: a row-level access change across every Lead-scoped table (Activity/Message/Booking/Reminder inherit it) to fix a scheduling concern; (B) only guard the null in `list()` and leave the write path broken - rejected, it hides a 42501 behind a cosmetic fallback and the exec still cannot complete a visit; (C) make the exec a full owner on schedule - rejected, §3 intends the telecaller to keep ownership at VISIT_SCHEDULED, and the handoff edge is reserved for the exec post-VISITED |

| 80 | Eng (2026-09-30) | **A NO_SHOW lead can be scheduled again, and the two lists that disagreed about which leads can take a visit are now ONE list in `@shadhil/api-types`.** New `SCHEDULABLE_LEAD_STATES` (`VISIT_REQUESTED`, `VISIT_SCHEDULED`, `RESCHEDULED`, `NO_SHOW`) and `VISIT_SCHEDULING_ADVANCES_FROM` (the same minus `VISIT_SCHEDULED`) in `packages/api-types/src/visits.ts`; the server guard (`VisitsService.create`), the lead picker (`ScheduleVisitDialog`), the lead page's panel (`LeadVisitPanel`) and the dashboard queue matrix (`queue-actions.ts`) all import them instead of restating them. `create()` now advances the lead to `VISIT_SCHEDULED` from any state in `VISIT_SCHEDULING_ADVANCES_FROM` (was `VISIT_REQUESTED` only) and supersedes the lead's outstanding `NO_SHOW` visit row in the same transaction (status → `RESCHEDULED`, `outcome` preserved, audited). The queue keeps one deliberate divergence and states it in code: it does NOT offer Schedule visit on `VISIT_SCHEDULED` (that row's action is "No show"; a parallel booking is the calendar's path), even though the endpoint accepts a create from it. | bug | P1,P5,P8 | Reported: "getting this error Lead state NO_SHOW cannot accept visit... If we can't schedule visit when lead status NO_SHOW, then why we show schedule visit button in queue" - the queue was right and the API was wrong. NO_SHOW is a side state with a live re-engagement edge (`NO_SHOW: ['VISIT_SCHEDULED','RNR','LOST']`), and the guard's own comment claimed RESCHEDULED existed so "a manager re-opening a no-show can re-schedule" - but a no-show leaves the lead in NO_SHOW, not RESCHEDULED, so the state the comment described was the one being refused. It survived because there was NO test of `create()` eligibility at all, while `queue-actions.test.ts` actively pinned NO_SHOW → Schedule visit as correct. | (A) backend accepts NO_SHOW only, no supersede - rejected, leaves the old NO_SHOW visit row in place and `LeadVisitPanel` aims the next outcome at whatever it finds first (`status === 'SCHEDULED' \|\| status === 'NO_SHOW'`), so the operator's next outcome hits `updateOutcome`'s already-NO_SHOW 409; (B) UI-only (hide the button) - rejected, it fixes the message by deleting the re-engagement the queue design specifies on NO_SHOW rows; (C) supersede EVERY open row on the lead - caught by our own test during implementation and rejected: this codebase treats `SCHEDULED`/`RESCHEDULED` as OPEN work (`isUpcomingVisit`, `OPEN_VISIT_STATUSES`), so it would silently cancel a live appointment; (D) rewrite the superseded row's `outcome` to `RESCHEDULED` - rejected, that column is the record that the customer did not turn up, and moving `status` alone is the same split `reschedule()` already leaves behind |
| 81 | Eng (2026-09-30) | **FIXED: the work dashboard's lead queue offered a "Schedule visit" button the API answered with 400 for a NO_SHOW lead.** The row-action matrix now decides membership from the shared `SCHEDULABLE_LEAD_STATES` (minus `VISIT_SCHEDULED`, see #80) rather than a literal three-state condition. | bug | P1,P5 | A refusal the operator reads as a broken tool is the failure `queue-actions.ts` says at the top it exists to prevent, and this was one: the queue's own `No show` button is a LEAD-only transition that leaves the `SiteVisit` row SCHEDULED, so a lead reaches NO_SHOW with a live visit and an offer to book one that the server refuses. Now the offered button and the accepted call cannot disagree - pinned by a test that reads the SERVER's constant in both directions. | (A) copy the four states into the matrix - rejected, that is the same duplication that caused it; (B) drop NO_SHOW from the lane so the row disappears - rejected, it hides live work instead of fixing it |

| 82 | Eng (2026-09-30) | **The visit dialog's status chip is now coloured by the LEAD state whose words it prints, not by the visit's status.** New `lib/lead-state-tone.ts` maps every `LeadState` to a calendar tone (`Record<LeadState, TEventColor>`, so a new enum value fails the BUILD, not just a test), reusing the calendar's own five-tone palette; `event-details-dialog.tsx` takes the chip's tone and icon from `leadStateTone(leadState)` while the "What happened on site" line keeps `visitStatusColor(status, outcome)` and gains the visit's icon as a dot, so the two axes are visually distinct. The chip gains a "Deal status" label and a `data-tone` attribute. The calendar CARD is unchanged - it still colours by visit status. | bug | P1,P5 | Reported: "Why won and Didn't show up shows green color in site visits calendar?" The chip printed the LEAD's label inside a pill coloured by the VISIT, so it could read "Won 🎉" (green because the visit COMPLETED - nothing to do with the deal) or "Didn't show up" over a green chip (the visit completed, the lead marked a no-show afterwards). One line, two records, two claims - and the dialog's own comment claimed the chip matched the lead page's badge, which it did in words only. The calendar card's visit-status colour is correct and was left alone: a calendar answers "did the visit happen", which is a different question from "where does the deal stand". | (A) colour the chip by the lead state via a new `LeadStatusBadge` prop - rejected, that component is a pill on the leads pages and the calendar chip needs a tone for its icon switch too; (B) reuse `STATE_BADGE_CLASS` directly - rejected, it holds Tailwind class strings, not a semantic tone, so a consumer cannot ask "is this positive?" without parsing CSS; (C) recolour the calendar CARD by lead state instead - rejected, it would undo the owner's 2026-09-29 request that the calendar answer "did the visit happen" at a glance; (D) leave the chip on the visit tone and only add the "Deal status" label - rejected, the label explains the confusion instead of removing it |

| 83 | Eng (2026-09-30) | **Past visits no longer render as solid outcome-coloured blocks: history drops to a neutral row with the outcome kept as a 4px left border + dot.** New `apps/web/src/lib/past-event-style.ts`; `CalendarProvider` gains `isPastView` (default false, so the vendored calendar's other consumers are unaffected) and `SiteVisitCalendar` passes `showPast === true`. All three card surfaces consume it through the library's `cn` (twMerge) merged LAST, so the override genuinely REPLACES the cva variant's `bg-*`/`dark:bg-*`/`text-*` rather than losing to Tailwind's emit order: agenda card, `EventBlock` (week/day), `MonthEventBadge` (month). The live calendar's presentation is untouched. | bug | P1,P5 | Reported: "Change background color in visits page when i select show past visits, for Arjun Reddy lead status was won but in visit card background color shows green". Green was CORRECT for the visit (COMPLETED) - deriving the card from the lead state would not have changed it, since WON maps to green too - so the real defect is that history was painted with a LIVE signal at all: the toggle does not filter to past-only (`showPast ? all : filtered`), so closed green/red/yellow rows sit in one list beside blue upcoming ones and the whole page becomes a colour wall. Owner's follow-up "use proper background color" settled the direction: neutral surface for history. | (A) derive the card colour from the LEAD state instead of the visit - rejected, it fixes nothing here (WON is green, so Arjun's card stays green) and it breaks the calendar's one job, answering "did this visit happen yet", which the visit status answers exactly; (B) make the toggle show ONLY past visits - rejected as unsolicited scope: it removes the ability to see overdue-and-upcoming together, and the past mode is legitimately "everything, with history included"; (C) remove the outcome colour entirely in history - rejected, a month of history then gives no way to tell a completed visit from a no-show; the left border + dot keep it scannable without tinting the row; (D) compose the border class as `border-l-${tone}-500` - rejected, Tailwind only emits literal class strings, so it would work in dev and silently vanish in the production build |

| 84 | Eng (2026-09-30) | **The visits calendar now has a colour key: `VisitColourLegend` ("What the colours mean"), a disclosure beside the Show-past switch.** Entries, order, words and tones are all DERIVED - `VISIT_STATUSES` for the list, `labelFor('visit', …)` for the words, `VISIT_STATUS_COLOR` (newly exported from `lib/visit-status.ts`) for the tones - so the key cannot drift from what the cards paint; only the one-line `meaning` sentence per status is authored. It names its own axis ("visits", not deals) because the previous two defects in this area were exactly that confusion. | feature | P1,P5,P8 | Owner: "I don't understand what each colors means in visits page card." The calendar encoded the visit outcome in colour and explained it NOWHERE - not on the card, not in the header, not in the dialog. Colour as the only channel for a fact is also a WCAG 1.4.1 failure, but the plain complaint is that nobody was ever told. | (A) put the meaning on each card face - rejected, it makes every row denser to answer a question asked once; (B) a tooltip per colour - rejected, undiscoverable on touch and unreadable to a screen reader; (C) always-visible key panel - rejected, five rows of permanent chrome above a calendar is a tax on every visit for an occasional question; (D) hand-write the key - rejected, that is the failure mode where the key and the picture silently disagree |

| 85 | Eng (2026-09-30) | **SUPERSEDES #83's surface treatment on owner direction: the past view's outcome is a SOFT background tint, not a left border.** `pastEventClass` now returns `bg-{tone}-50/70` + `dark:bg-{tone}-950/50` + `border-border text-foreground`; the `border-l-4 border-l-{tone}` accent is gone. The outcome DOT keeps its full-strength variant fill (the past override deliberately does not touch `[&_.event-dot]`), and the live calendar's full-strength surface is unchanged. | design | P1,P5 | Owner saw #83 and replied "I want soft background color instead of border color in visit page". Soft rather than the live card's full `bg-{tone}-50`: a wall of saturated blocks is what made the past view unreadable in the first place, so the hue returns at reduced strength and the row reads as calmer than a live one while staying identifiable. | (A) revert to the live card's full-strength fill - rejected, that is the exact wall of colour the original report complained about; (B) keep the border AND add the tint - rejected by the owner's wording ("instead of"); (C) use design-system tokens (`bg-success/10`) so the tint is theme-correct - rejected, the calendar's palette is Tailwind's own and a token tint would not match the dot beside it; (D) override the dot to `currentColor` as the first attempt did - rejected, the dot is the one cue that survives a soft tint at a glance |

| 86 | Eng (2026-09-30) | **SUPERSEDES #85's dilution on owner direction: the past view's outcome tint is the standard `bg-{tone}-50` / `dark:bg-{tone}-950` at full strength, not `bg-{tone}-50/70`.** The only remaining difference between a history row and a live row is now the FRAME and TEXT: history takes `border-border` + `text-foreground`, live keeps `border-{tone}-200` + `text-{tone}-700`. The dot stays full-strength in both. A test asserts past and live are still distinguishable, since the fill no longer separates them. | design | P1,P5 | Owner, third pass on the same appearance call: "I don't want so soft background color, i want decent background color". The `/70` wash was too faint. Useful conclusion recorded: diluting the fill never addressed the original "wall of colour" complaint - de-saturating the TEXT and FRAME does, which is why history is quieter than live even at an identical fill. | (A) `bg-{tone}-100` (one step deeper than `-50`) - rejected, that is LOUDER than the live card, and `-50` is the standard tint "decent" describes; (B) back to the live card's treatment entirely - rejected, it would erase the history/live distinction that #83 introduced for a reason; (C) keep `/70` and only deepen the dark-mode shade - rejected by the owner's wording, which is about the light tint being too faint |

| 87 | Eng (2026-09-30) | **SUPERSEDES #86's `-50` fill on owner direction: the past view is now a solid `-500` chip with the `border-l-4` accent RESTORED, dark text, and a dot re-pointed to `currentColor`.** `PAST_TONE_SURFACE` holds fill + frame + accent per tone (`bg-{tone}-500`, `border-{tone}-600`, `border-l-{tone}-700`); `PAST_ACCENT_WIDTH_CLASS = 'border-l-4'`; `PAST_TEXT_ON_FILL = 'text-neutral-950'`. The live calendar keeps the `-50` tint and no accent. | design | P1,P5,P8 | Owner, passes 4 and 5 on one appearance call: "Use *-500" then "Use previously used border left". Two consequences were MEASURED before writing them, and both are now asserted by re-computing the values rather than trusting the class strings: (1) on `-500` the text must be near-black - white fails WCAG AA on every coloured tone (green 2.28:1, yellow 1.92:1, blue 3.68:1) while `text-neutral-950` passes on all (green 8.69:1, worst case purple 5.00:1); (2) the accent CANNOT be `-500` - it was visible against the old neutral row and is invisible on a `-500` fill, so it moves to `-700`. The dot changes colour rather than merely surviving: `fill-{tone}-600` is adjacent to `bg-{tone}-500` and would vanish. | (A) restore `border-l-{tone}-500` verbatim - rejected, same colour as the new fill, so the accent would be present in the markup and invisible on screen; (B) white text (the intuitive choice on a saturated fill) - rejected by measurement, fails AA on every coloured tone; (C) no opacity/softening - rejected by the owner's explicit "-500"; (D) keep the dot's `fill-{tone}-600` - rejected, an adjacent shade on a solid fill stops marking anything |

| 88 | Eng (2026-09-30) | **SUPERSEDES #87's fill on owner direction ("Undo background color"): the past-view surface is back to the light `-50` tint, and the strong `border-l-{tone}-500` accent from #87's "previously used border left" is KEPT.** Text returns to `text-foreground` (dark on a light fill) and the `[&_.event-dot]:fill-current` override from #87 is REMOVED, because on a light fill the variant's own `fill-{tone}-600` dot is the visible cue again. The legend swatch now matches the card's ACCENT STRIPE rather than its fill, since a `-50` swatch would be barely visible at legend size. | design | P1,P5 | Sixth pass on one appearance call. READ AS: undo the `-500` BACKGROUND, keep the accent - the owner asked for the accent one message earlier and did not retract it. The alternative reading ("remove the background entirely, i.e. the step-2 neutral row") is one line away and is recorded in the module header of `past-event-style.ts`. Six passes on one colour is itself the signal: this is a taste call being calibrated by eye, so the module header now logs the whole sequence rather than only the current state. | (A) undo the accent too, back to the step-2 neutral row - rejected, the owner asked for that accent in the immediately preceding message; (B) `bg-{tone}-100` as a middle ground between `-50` and `-500` - rejected, unrequested after a pass that was specifically about undoing, and `-50` is the shade already accepted as "decent"; (C) keep the `-500` fill and only lighten the text - rejected by "undo background color" |

| 89 | Eng (2026-09-30) | **FIXED the four ways a visit-status change failed to reach the lead (or failed silently).** (1) `reschedule` matched a hardcoded trio of lead states, so a move on a lead in `CONTACTED` did nothing; the target is now COMPUTED from `allowedNextStates(state, role)` - one source of truth for the edge AND its role gate. (2) A role the lead machine will not let drive the edge got no lead write and NO WORD ABOUT IT, reachable and routine (a SALES_EXEC may mark a visit NO_SHOW while the lead's `VISIT_SCHEDULED -> NO_SHOW` edge is telecaller/manager only); `VisitRow.leadSyncNote` now carries the reason and all four visit surfaces toast it. (3) `reschedule` could throw Forbidden where `updateOutcome` deferred - the role check is now done first, so the move is recorded instead of failing. (4) FOUND WHILE FIXING: `updateOutcome` dereferenced `existing.lead.state` with no null guard, so an exec recording an outcome on a visit whose lead had never been shared to them (`siteVisit.lead` null under `lead_select_telecaller`) crashed with `Cannot read properties of null` - a 500 for a legitimate request. Now a typed `ConflictException` naming the fix. | bug | P1,P2,P5 | Owner: "If we change status from visit page, we should update status in lead as well, can you check whether this logic present or not". The sync WAS present in both directions; what was missing was coverage (1), the reporting (2), the role-safety (3) and the null guard (4). (2) is the operator-facing one: a red visit beside a "Visit booked" lead with nothing connecting them is how this gets reported as "the status didn't update". `CANCELLED` remains a deliberate non-sync by owner ruling and deliberately does NOT raise a note. | (A) force the lead transition regardless of role - rejected, it overrides the lead machine's role lanes, which is the authority this module defers to; (B) widen the lead's NO_SHOW edge to SALES_EXEC - rejected as a Model C behaviour change the owner has not asked for (the note makes the divergence visible instead); (C) hide the visit dialog's No-show button from execs - rejected, it hides a real divergence rather than reporting it; (D) swallow the null lead and record the visit anyway - rejected, it would record a visit whose lead cannot be synced while telling the user nothing |
| 90 | Eng (2026-10-01) | **SLOs set: 99.9% for web+api, 99.5% for SSE, 99.9% for data, 99.0% for background jobs, measured over a rolling 30 days. Current availability is recorded as UNMEASURED - no monitor exists yet.** New `docs/operations/SLO.md` holds the targets, the 43m50s monthly error budget, the error-budget policy, phased work to earn them, and the incident-response ladder. | architecture | P1,P6 | Owner requirement: "24/7 reliability site, no failure if it fails it should recover from that failure". That requirement is unquantified, and an unquantified reliability target cannot be reasoned about or defended - so the first thing it needed was a number. 99.9% is chosen because it is REACHABLE ON THE CURRENT SINGLE VPS: `restart: unless-stopped` already covers crashed processes, the SSE client already reconnects with backoff and `Last-Event-ID` replay, and cron work is already crash-idempotent, so the remaining gap is deploy-time downtime plus detection, not architecture. 99.95%+ was rejected as a target because it is NOT reachable here - one VPS is one point of failure and that needs a second node with Postgres replication. Recording that limit explicitly stops a contractual figure being promised by accident. The honest current state is stated in the doc: zero measurement, so no figure may be quoted to the client until Phase A (monitor + alert + health checks + log rotation) is done. | (A) target 99.99% and buy a second node now - rejected as premature spend before the current box is instrumented; (B) target 99.0% (a day a year) - rejected, a 7-hour monthly outage is not a CRM a builder's sales team can run on and it undersells what one well-run node already does; (C) leave reliability undocumented and rely on `restart: unless-stopped` - rejected, that is how "24/7" becomes a shared assumption with no agreed meaning |
| 91 | Eng (2026-10-09) | **Visit booking flow:** manual "Visit booked" transition removed (booked only by Schedule visit, which auto-moves the lead); added one-step-back edges (CONTACTED→NEW, VISIT_REQUESTED→CONTACTED, VISIT_SCHEDULED→VISIT_REQUESTED which cancels the open visit, NEGOTIATION→VISITED) and "request visit again" (VISITED/NEGOTIATION→VISIT_REQUESTED); SALES_EXEC gets a second reserved edge VISIT_REQUESTED→VISIT_SCHEDULED to book the repeat visit (lead stays with exec) | mechanical | P1,P5 | customer revisits with family; booked state must always have a visit row | VISITED→VISIT_SCHEDULED back edge; BOOKING_INITIATED rollback (booking-driven) |
| 92 | Eng (2026-10-09) | **Lead timeline writes Activity rows (1A):** every lead action (transition, create, reassign, co-owner, visit create/outcome/reschedule) writes an `Activity` row in the SAME transaction via `recordLeadActivity`; an RLS rejection hard-fails the action (no try/catch). Pinned by the RLS matrix Activity INSERT block. | mechanical | P1 | a silently empty timeline is worse than a loud failure | best-effort insert |
| 93 | Eng (2026-10-09) | **Lead-state labels shared (2A):** `LEAD_STATE_LABELS` / `leadStateLabel` live in `@shadhil/api-types`; web `labels.ts` and the backend timeline sentences both import it. | mechanical | P4 | one source, no drift | duplicate map in backend |
| 94 | Eng (2026-10-09) | **All events + backfill (3A):** new `ActivityType.ASSIGNMENT` (migration 1) and an idempotent AuditLog -> Activity backfill (migration 2, two migrations because Postgres cannot use a new enum value in the transaction that adds it). Visit-driven transitions fold into ONE VISIT row (`transitionInTransaction(..., 'skip')`). | mechanical | P1 | existing leads keep their history | forward-only |
| 95 | Eng (2026-10-09) | **Timeline read is cursor-paged (supersedes the 200-row cap of 4A):** `GET /leads/:id/activities?cursor&limit` returns `{ items, nextCursor }` - default 50, max 200, walking backwards in time with an opaque (createdAt, id) keyset cursor; items are oldest-first within a page. Web uses `useInfiniteQuery` and a "Load earlier events" button. | mechanical | P3 | unbounded read, no lost history | fixed 200-row cap with a "Showing latest 200" note |
| 96 | Eng | T-UNIT-NEGOTIATION (2026-10-09): unit total = buildup sq.ft x per sq.ft price (derived, strict); booking `amount` = negotiated rate x buildup when a rate is entered, else list amount. REVERSES T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16: amount == unit price) | taste | P5 | owner ruling: customers negotiate; list amount kept in `Booking.listAmount` for audit; server derives all money figures, client sends only the rate | free-typed amount; informational-only negotiated field |

## Cross-Phase Themes

### T-WA-WINDOW (2026-09-29): the 24h reply window is enforced, and a Welcome button

Owner instruction: on the lead's customer chat panel, a thread with no messages
shows a "Welcome Message" button that sends an approved WhatsApp template; the
correct flow (after being told the Meta constraint) is that the composer stays
blocked until the CUSTOMER replies.

**The feature was half-built, in one place.** `ChatThreadPanel` (the
`/whatsapp-chat` page) already had `replyWindowState()`, `closedWindowMessage()`
and a composer that is replaced by a notice rather than left as a dead input.
`LeadChatPane` (the lead detail page) had none of it - no inbound timestamp, no
window awareness. The shared contract now lives in `@shadhil/api-types`
(`isServiceWindowOpen`, `serviceWindowExpiry`, `CLOSED_WINDOW_MESSAGE`) so the
server guard and both composers cannot disagree.

**A live defect this closed.** The window was NOT enforced server-side: `send()`
enqueued a FREEFORM outbound for any customer message when the lead had a phone.
Outside the window Meta rejects it with `131047`, the OutboundMessage row died as
a silent `FAILED`, and the operator saw a message that the customer never
received. The API is now the enforcement point, and it mirrors the enqueue
condition EXACTLY (`channel === 'WHATSAPP' || (IN_APP && phoneE164)`) - a gate
that is wider than the thing it protects would refuse legitimate sends, and a
narrower one lets doomed sends through.

**The correction that shaped the design.** Owner initially asked for: click
welcome → then allow freeform for 24h. That has no valid state. Meta's docs:
"When a WhatsApp user messages you or calls you, a 24-hour timer called a
customer service window starts." Only the CUSTOMER's inbound opens it; a
business template does not, and neither does the customer receiving one. So
enabling the composer after the template would let staff type freely into a
closed window and every message would fail at Meta - the exact silent-failure
above. The button still earns its place as the only compliant cold-outreach path
(a business may ALWAYS send an approved template), it just does not unlock the
composer.

**States:** no inbound → Welcome button, no composer. Template sent, still no
reply → "opens when the customer replies". Customer replied → composer, freeform
for 24h. Window expired → closed notice + Welcome again (labelled "Send welcome
again"). Loading → CLOSED (fail closed: a slow request must never briefly enable
a composer the API refuses).

**The template is the operator's to create.** `WA_TEMPLATE_WELCOME` names it; the
body, category and parameter mapping are in `docs/planning/WA-WELCOME-TEMPLATE.md`.
Not hardcoded, because a literal name Meta has not approved fails every send with
`132001` - which is exactly how `shadhil_chat_reply` came to be referenced in this
codebase while never existing. Unset → a 400 naming the env var, never a silent
no-op or a success toast.

**Tests re-pointed, not worked around.** Four existing suites sent a CUSTOMER
message into a thread with no inbound - i.e. they were asserting the old
defective contract. They now open the window with a real customer inbound, or use
an INTERNAL note when the test is about the insert path rather than WhatsApp
delivery.

**Verified:** api-types 110, backend 1197, db 163, web 794; lint 7/7; guardrail
pass; type-check exit 0. Tampers: remove the pane gate → 4 web red; remove the
server guard + flip the welcome send to FREEFORM → 3 backend red. CI still dead
on the Actions billing failure.

### T-MENTION-TARGET (2026-09-29): an @mention is a real access grant

Owner instruction: "3" - the targeted-mention option, then option **A** for the
scope question. Both decisions are load-bearing, and the second one changes the
security model.

**The defect this closes.** A telecaller writes an INTERNAL note on a lead they
own and mentions a sales_exec. Before this work:

| what happened | why it was wrong |
|---|---|
| `emitMentions` re-parsed `@Name` from the body and matched `User.name` | identity by display name - a mention landed on ANY same-named user in the org (ordinary staff resolved **org-wide**) |
| the notification body was `body.slice(0, 100)` | the note's first 100 chars were quoted to someone with no access to the rest |
| the recipient could not open the lead | `message_select_team` gates on the parent Lead's owner/co-owner, so the mention granted nothing and the notification dead-ended |

**What it does now.** The composer sends the picked row's `mentionedUserIds`; the
service writes a `MessageRecipient` row **in the same transaction** as the
message; that row is an RLS grant of the lead **and its full thread**.

**Option A is the security decision, not a UI nicety.** A mention hands over the
lead AND the customer WhatsApp conversation, so WHO may be addressed is an
authorization boundary. Targets are bounded to the actor's team scope by reusing
`UsersService.teamMembers` - the mention picker's OWN source - so the server
accepts exactly who the UI can offer. A second copy of those rules would drift,
and drift here means either a refused legitimate mention or an offered teammate
the server rejects.

**The recursion trap, and the fix.** `Message`'s policy already reads `Lead`. A
`Lead` policy that reads the grant table through `Message` closes the cycle
`Lead -> MessageRecipient -> Message -> Lead`, which Postgres reports only at
SELECT time (`infinite recursion detected in policy for relation "Lead"`) - the
migration applies cleanly and looks fine. So `leadId` + `organizationId` are
DENORMALIZED onto the grant table and every policy on it reads its OWN columns.
That is the same reason `Message.organizationId` exists; it is not an
optimisation.

**Key on the LEAD, not the message.** The first draft matched the mentioned
message, and the live probe caught it: the exec could read the note but got **0
rows** for the customer's message on the same lead - a notification pointing at a
thread they still could not read. Consequence, stated rather than discovered
later: once mentioned on a lead the recipient reads ALL its messages, past and
future. That is what a grant means, and it is why the target bound matters.

**Verified.** api-types 100, backend 1195, db 158, web 782. Tamper checks: remove
the team bound -> the out-of-scope test reddens (and only that one); remove the
grant write / restore the 100-char teaser -> 4 red. Two-connection RLS probe:
baseline without the grant row lead 0 / note 0 / customer 0; with it 1 / 1 / 1;
stranger 0; a manager cannot enumerate another user's grant rows; no recursion on
full scans. Test-DB caveat: `shadhil_crm_test` is NOT migrated by the suite, so
the migration had to be applied there by hand and recorded in `_prisma_migrations`
- otherwise every RLS-backed chat test fails with "table does not exist".

### Token amount cannot exceed the booking total (2026-09-28)

Owner instruction: "if tokenAmount provided that shouldn't be greater than
totalAmount". A token is a PART payment of that booking, so the cap is a
correctness rule on the money, not a nicety.

Enforced at every path that can set a token, with the comparison defined ONCE
(`isTokenWithinTotal`) so the layers cannot drift:

| path | where the total comes from |
|---|---|
| `CreateBookingDto` | same payload - `superRefine` on both fields |
| `BookingsService.transition` | the STORED `amount` (the DTO has no total) |
| `BookingsService.update` (token set) | stored total, or the incoming `amount` |
| `BookingsService.update` (total lowered) | stored token - see below |
| create form / detail page / RecordTokenDialog | the booking's own `amount` |

**The second direction is the one a per-field check misses.** Lowering the TOTAL
can strand an existing token above it, so editing a booking one field at a time
could otherwise produce "token 5L of a 4L unit". `update` therefore also validates
when only `amount` arrives. Caught while writing the rule, not in production.

**Also fixed: the client/server token TYPE mismatch** - the reported error
"Invalid input: expected string, received number". The `@paalstack/react-ui`
number field writes `event.currentTarget.valueAsNumber` into the form (a NUMBER,
`undefined` when blank) - verified by reading the library's compiled Form - while
my schemas declared `z.string()`, so every submit failed before reaching the API.
The rule now lives once as `TokenAmountSchema` and is imported by the DTOs, the
detail page, the dashboard dialog and the tests. My own dialog test had copied the
same wrong assumption, which is why it did not catch it: a test that mirrors the
mistake cannot detect it.

Note `BookingEditDialog` deliberately keeps its string-based fields - it uses
`type: 'input', inputType: 'number'`, which emits a STRING and coerces on submit.
The repo has BOTH numeric patterns; `type: 'number'` is the one that emits numbers.

**Time-of-day fragility, again.** The full suite reddened 4 tests at 00:37 that
passed at 23:51: fixtures placed at "midnight + 1h" (a future instant just after
midnight, so the `scheduledFor <= now` filter dropped them) and "now minus 1h" (an
instant on the PREVIOUS day shortly after midnight, flipping a reason to
`overdue-past-due`). Both now use midnight itself, which is "today" and "not after
now" at every hour. That is the third instance of this class in this session - all
three from time-relative fixtures, none from the application.

### Approval requires a recorded token amount (2026-09-28)

Owner instruction: "Don't approve booking without token amount A-103".

Approving asserts the token was RECEIVED, so it is only meaningful against a
recorded amount. Until now `TOKEN → APPROVED` was reachable on a booking whose
`tokenAmount` was NULL - including A-103 - which closed the deal with the payment
permanently unrecorded. Enforced in two places, because they are two different
holes:

- `BookingsService.transition`: `toStatus === 'APPROVED'` is refused when the
  stored amount is not positive. Independent of the HOLD → TOKEN rule, which
  prevents CREATING the defect; this prevents CEMENTING an existing one.
- The booking detail page: Approve is not offered while `tokenAmount` is
  missing/zero, so the UI never presents an action the API refuses - and the card
  STATES why and how to fix it, because a control that silently vanishes reads as
  a broken tool. Reject and Cancel stay available: refusing approval must not trap
  the booking in TOKEN.

`0` counts as missing, not present - a zeroed column must not unlock approval.
Note `ApproveBookingDtoSchema` exists in `@shadhil/api-types` but is referenced
nowhere: approval goes through `transition`, so a guard added there would have been
dead code. Verified 85 bookings tests, 18 page tests, plus tampers on both layers
(removing the service guard reddens 2; removing the UI gate reddens 2).

**Also fixed in passing - a fragility in my own earlier test.** The
`status-truth.agreement` discriminator had been placed relative to midnight, and
the band `[now-24h, midnight)` narrows to 60 seconds by the end of the day, so from
~23:30 the fixture stopped discriminating and the suite PASSED AGAINST the bug
(observed at 23:51 with a real red on the guard-the-guard assertion). It is now
placed one minute before midnight and the guard assertion SKIPS visibly in the
final minute, since no fixture can discriminate then - a visible skip rather than
a silent pass or a false failure. Re-verified at 23:51: tampering the rolling-24h
query now reddens 2 tests where it previously reddened none.



Reported: "Fix it Existing TOKEN bookings with a NULL amount".

**THE AMOUNT IS NOT RECOVERABLE FROM THE DATABASE - this is the whole answer.** I
checked every possible source before writing anything:

- no payment / token / transaction model exists in the schema (verified by
  searching every `model` and `enum`);
- `Booking.tokenAmount` is null on these rows by definition;
- the `booking.create` audit row records only `leadId/unitId/amount/status` - it
  does not capture `tokenAmount`;
- the `booking.transition` audit row records only the status pair.

So the only source for the figure is outside the system - the bank entry or
receipt. Filling it with a placeholder (0, the booking amount, anything) would make
the data LOOK complete and be wrong, corrupting the "Booking money" card in the
opposite direction by reporting a token paid that never was. **The repair therefore
takes an operator-supplied amount rather than inventing one.**

**Two real defects found and fixed rather than assumed:**

1. **`update()` could CLEAR `tokenAmount` on a TOKEN booking.** The bookings EDIT
   form is the only UI that writes `tokenAmount` - i.e. it is the repair tool - and
   it accepted `tokenAmount: null`, so the first edit would silently undo any
   repair and re-create the anomaly. Now refused when the booking is TOKEN;
   correcting the amount is still allowed. (Found by reading the write path instead
   of assuming the transition rule was the only hole.)
2. **The dashboard reported these rows as `hold-no-token`.** That reason reads as
   "the money is still with the customer" - backwards for a booking marked as paid
   - and it made the defect invisible to anyone looking for it. The card now has a
   distinct `token-recorded-missing-amount` reason rendering "Amount missing /
   marked received · Nd" with a "Fix amount" action, so the rows are findable and
   each one points at the screen where it can be repaired.

**The repair tool**: `apps/backend/scripts/repair-token-amounts.ts`. Diagnoses by
default; writes only with `--apply`, which additionally requires `--actor` (an
unattributed change to money is not acceptable) and a positive `--amount`. Only
`tokenAmount` is written - never `status`, because `syncLeadState` derives the
LEAD's state from all of a lead's booking statuses, so touching a status could move
a lead. It re-reads the row inside the transaction and refuses if the status
changed or an amount is already recorded, and writes an AuditLog row per repair
(`booking.token_amount_repair`, before/after) so the change is attributable and
reversible.

**A trap this script had to defend against, which invalidated an earlier report of
mine.** The app connects as the non-owner `shadhil_app` role, which is subject to
RLS; with no `app.user_id` set, policies filter every row away. A naive version
would print "None. Every token-received booking records how much was received."
while the defect sat untouched - a reassuring lie, the worst output for a repair
tool. `assertCanSeeData()` counts rows first and refuses to report otherwise. This
is also why I earlier told the owner the dev database was empty: I queried the app
role, saw 0 rows, and wrongly concluded there was no data. The dev DB in fact holds
31 leads, 3 bookings and 4 visits, and **one of them is the real defect**: Unit
A-103 · Arjun Reddy · booking 4100000.00 · `tokenAmount = NULL`. Inspect data with
`DIRECT_DATABASE_URL` (owner, bypasses RLS), never `DATABASE_URL`.

**Verified end to end against the local DB** with a real fixture row in the exact
broken state: detected; refused to write without `--actor`; refused a zero amount;
skipped a booking whose status was not TOKEN; repaired; wrote the audit row; left
the lead's state untouched; and was idempotent on re-run (`skipped-not-broken`).
The fixture was then removed. **The real Arjun Reddy row was deliberately NOT
touched** - its amount must come from the payment record, which is the owner's to
supply.



Scope: `docs/planning/SCOPE-visit-close-and-token-gate.md`.

**T-VISIT-CLOSE.** A `SiteVisit` was closed only by `updateOutcome`, which the UI
offers per visit, and nothing tied a visit's life to its lead's. So a deal that
ended left its open visit behind, with a past `scheduledFor`, forever - surfacing
on the "Visits at risk" card, the visit list and the calendar (the latter two
apply no lead-state filter; verified), consuming the list's 100-row LIMIT, and
worst, letting a stale `updateOutcome` advance a terminal LEAD (`LOST → VISITED`)
which the state machine forbids and the visit-level guard could not see. Confirmed
by grep that `CANCELLED` - a real `VisitStatus` named in both state machines - is
never written by any production code.

Fix: `closeOpenVisitsForLead(tx, actor, leadId, reason)` in the visits module,
called inside the SAME transaction as the state change that caused it, from
`LeadsService.transition` and `BookingsService.transition`; plus a backstop in
`VisitsService.updateOutcome` refusing a terminal lead.

**The judgement call, and a bug my own test caught.** The first draft guarded the
cascade with `isTerminalLeadState` (WON/LOST/RNR) while its docs said "WON does
NOT close visits" - the predicate and the intent contradicted each other, and the
cascade silently cancelled the handover visit on every won deal. Fixed by
splitting the concepts in `@shadhil/api-types`: `isTerminalLeadState` (leave out
of a needs-attention count) vs `isDeadLeadState` (LOST/RNR only - close what is
attached). Both are now pinned by test. Booking `TOKEN` likewise does not cascade:
the token is paid but approval is pending, so the deal is live.

**T-TOKEN-GATE.** `PATCH /bookings/:id` → `TOKEN` set `status = 'TOKEN'` and never
read or wrote `tokenAmount`; the transition DTO had no such field. A booking could
therefore be marked token-received with `tokenAmount = NULL` - unverifiable, and
actively misread: the admin "Booking money" card computes
`tokenPaid = tokenAmount !== null && > 0`, so a NULL token renders as "HOLD - no
token" (money still with the customer) for a booking the operator just marked
paid. Fix: `tokenAmount` required on HOLD → TOKEN, enforced at the DTO (error on
the `tokenAmount` field), at the service (the invariant, so a direct call cannot
bypass it), and in the UI (a new `RecordTokenDialog`, since the amount makes the
action a form rather than a one-click step). The value is written in the SAME
update as the status, so the two cannot drift.

**Not "always required"**: `CreateBookingDto` accepts a token amount at HOLD
time, so a stored positive amount already satisfies the invariant. Rule = one must
EXIST, from either place. Boundary strict, invariant tolerant.

**Deliberately out of scope** (owner data, not this repo): repairing existing
`TOKEN` bookings with a NULL amount, and backfilling orphan visits. Both are
one-off data tasks once the write paths are correct.

**Verification.** api-types 98, backend 1176, db 158, web 780; type-check exit 0;
lint 7/7; guardrail pass. Tampers: removing the service token guard reddens 1 test;
removing the visit cascade reddens 1; making the cascade fire on every state
reddens the WON exception. The dashboard's "Record token" no longer fires
`{ toStatus: 'TOKEN' }` bare - that call is now REJECTED by design, and the row
opens the dialog.

### T-VISIT-RISK-STATUS (2026-09-28): a settled deal must not be a visit risk

Reported: "In admin/overview Visits at risk section, Arjun Reddy lead status is won
and but this leads shows in visit at risk".

**Not a stale cache, and not the lead's fault.** The card's query filtered only on
the VISIT (`status IN (SCHEDULED, RESCHEDULED) AND scheduledFor <= now()`) and
ignored the parent lead's state entirely. Confirmed against real rows: a
SCHEDULED visit on a WON lead and one on a LOST lead both came back.

**Why the rows exist.** A `SiteVisit` is a per-visit artifact that NOTHING closes
when its lead goes terminal. Recording a visit outcome drives the LEAD (COMPLETED
→ VISITED) but never touches other visits, `reassign`/`setCoOwner` do not touch
visits, and the state machine's `VISIT_SCHEDULED → CANCELLED` is a *lead* edge -
`CANCELLED` is a `VisitStatus` that is never actually written. So a visit can
outlive its deal indefinitely with a `scheduledFor` stuck in the past.

**Fix.** `lead: { state: { notIn: TERMINAL_LEAD_STATES } }` on the query, so the
stale rows cannot fill the `take: 50` and hide live ones. `RESCHEDULED` and
`NO_SHOW` are deliberately NOT excluded - the deal is still live there, so the
visit genuinely needs attention. `VisitRiskException` also gains `leadStatus`, and
the card shows it: the visit's own `status` is permanently
SCHEDULED/RESCHEDULED, which is why the operator could not tell what state the
deal was in.

**The jargon.** "past due" was undocumented internal wording. The row now reads
`overdue · was due 25/09/2026` (the slot is before today) or `due today` (the slot
is earlier today but not before midnight) - and the empty state, which read "No
open visits have past their slot today" (a broken sentence), is now "No scheduled
visit is overdue or due today."

**Verification.** Pinned twice, because the two harnesses prove different things:
`dashboard.exceptions.test.ts` asserts the query's `where` carries the relation
filter (a mocked client never applies it), and `status-truth.agreement.test.ts`
asserts against REAL rows that the WON/LOST visits are absent while the live ones
survive - the only harness that can show a Prisma relation filter actually works.
Tamper: removing the filter reddens 1 test in each.



### T-STATUS-ONE-TRUTH (2026-09-28): one definition per number

Reported as "Leads status is mismatch between leads and admin/overview". Four
surfaces each computed "which leads are new / overdue / idle" their own way, so
the numbers on screen disagreed for the same words:

| surface | label | definition before |
|---|---|---|
| admin/overview | "Leads not called" | `state NOT IN (WON,LOST,RNR) AND updatedAt <= now() - 1 day` |
| leads page | "N overdue" | `state='NEW' AND createdAt <= now() - 30 min` |
| leads page | "N new today" | `state='NEW' AND createdAt >= now() - 24h` |
| work dashboard | "New today" | `createdAt >= midnight`, **ALL states** |

Two of these were outright defects. The dashboard's "New today" ignored state, so
**marking a deal WON raised the count**; and its caption read "created in the last
24h" while its query used midnight. The leads page used a rolling 24h window for
the same words the dashboard defined as a calendar day. Four numbers, none
agreeing, over overlapping concepts - and each endpoint's own test happily
asserted its own definition, which is why nothing caught it.

**The fix is structural, not arithmetic.** `packages/api-types/src/lead-status.ts`
now owns `TERMINAL_LEAD_STATES`, `OVERDUE_AFTER_MIN`, `NEW_TODAY_STATE`,
`startOfToday()`, `isOverdue()` and `isNewToday()`; both NestJS services and the
Next views import it. `apps/web/src/lib/leads.ts` re-exports the same bindings so
its existing callers are unchanged.

**Decisions.** (1) "New today" = created since LOCAL MIDNIGHT **and** still NEW -
the leads page's own tooltip already promised this, and a calendar window is what
an operator reconciles at end of shift, whereas a rolling window would drop
yesterday's leads off the number mid-morning. (2) The idle card keeps its own
question - "nobody has touched this in a day" is genuinely different from "a NEW
lead missed its 30-minute SLA" - so it is **renamed** rather than aligned, and now
states its threshold and scope. (3) It reads `Lead.updatedAt`, which bumps on ANY
write, so it was retitled "Going stale" (from "Leads not called"): the Activity
table that would carry a real call timestamp is still unwritten by production
code, and the old title promised data that does not exist. Fix the label, not the
number. (4) The card stays cross-project - a correct difference from the
single-project leads page - and now says so in its subtitle.

**Verification.** `apps/backend/src/leads/status-truth.agreement.test.ts` calls
BOTH real services against a REAL database over one shared fixture and asserts the
counts agree AND equal a hand-derived truth. Both halves were tamper-checked: with
the state filter removed 3 tests go red, with the rolling window restored 2 go red.
The rolling-window discriminator is placed adaptively inside `[now-24h, midnight)`
- a fixed "midnight minus 2 hours" silently passes against the bug after 22:00
local, which the first version of this test did until the tamper check caught it.

- **Theme: silent security gaps** - flagged in CEO (§2/§3), Design (offline states), Eng (G-1/G-2/G-3/G-5).
  High-confidence signal: the scaffold's RLS layer is the crown jewel AND the most fragile part
  (never-applied policies, fail-open edges, bypass paths).
- **Theme: timeline optimism** - CEO (P-1) and DX docs cadence both push early hardening of
  ship-blocking items (CI in Week 1, docs weekly).

## Implementation Tasks (aggregated)

- [x] **T-D4 (P1, human ~6h / CC ~45min)** - mobile+backend - Offline visit-outcome queue (save-local, retry, dedupe, conflict rule)
  - Surfaced by: design D4 + eng #11 - Files: apps/mobile visit module, apps/backend visits controller
  - Verify: Maestro flow offline-outcome.yaml + unit test for conflict resolution
  - DONE 2026-09-05 (commit d72819e): web+backend slice - idempotent-replay + stale-write 409 conflict rule (visits.service), enqueueUnique dedupe (offline-store), LeadVisitPanel offline fallback + isOfflineError, replay auth fix (/api/bff - old /api/backend rewrite dropped the `api` prefix AND had no Bearer token → every replay 401/404), badge replay query invalidation. Gates: backend 646, RLS 135, web 219, offline-store 26. DEFERRED with mobile (Weeks 8-10): Maestro offline-outcome.yaml, SW Background Sync replay handler, apps/mobile visit module.
- [x] **T-D3 (P1, human ~4h / CC ~30min)** - all UI - State matrix: loading/empty/error/partial per surface + SSE Connected/Reconnecting/Offline pill spec
  - Surfaced by: design D3+D5 - Files: apps/web features, apps/mobile screens, WIREFRAMES.md
  - Verify: Playwright per-surface state tests
  - DONE 2026-09-05 (commit 0bdcf67): docs/planning/STATE-MATRIX.md (single source of truth for the loading/empty/error/partial contract + SSE pill states) + vitest state-matrix tests for the 3 largest untested surfaces (leads list 4 cases, leads/[id] detail 3, users 5 - pins the users page's inline-error-by-design choice). Remaining smaller surfaces (visits calendar, inventory, bookings/new, root dashboard) are listed as gaps in STATE-MATRIX.md; Playwright e2e variant deferred with apps/mobile (vitest chosen per repo convention - no @testing-library/react).
- [ ] **T-D8 (P1, human ~1h / CC ~10min)** - ui-tokens - WCAG AA status token set + chip styles
  - Surfaced by: design D8 - Files: packages/ui-tokens, WIREFRAMES.md legend
  - Verify: contrast check script in compliance.test.ts
- [ ] **T-E2 (P1, human ~3h / CC ~25min)** - backend - SSE one-time stream tickets (?ticket=, short TTL, bind userId+leadId, no token in logs)
  - Surfaced by: eng voice #2 - Files: apps/backend/src/realtime, new tickets service
  - Verify: integration test: expired/replayed ticket rejected
- [x] **T-G1 (P1, human ~4h / CC ~30min)** - backend - Route ALL request-scoped business writes through withRlsContext; §18 reassign rewritten in-transaction (fetch+update+reminders+audit+SSE), owner/ADMIN guard, coOwnerId cleanup
  - Surfaced by: eng G-1/G-5-critical - Files: apps/backend/src/leads/*, packages/database/src/rls.ts
  - Verify: reassign integration test + lint rule/grep CI check banning bare prisma in controllers
  - DONE 2026-09-05 (commits f49eae2 + this one): reassign endpoint (POST /api/leads/:id/reassign) fully inside withRlsContext - owner/ADMIN guard, team-scoped MANAGER guard, canRoleOwnState target-role check, same-owner no-op, coOwnerId preserved (dedicated coOwner endpoint is the follow-up), teamless-target teamId preservation; leads.reassign.test.ts 11 real-DB tests (ADMIN cross-team, MANAGER same/cross-team 403, TELECALLER/SALES_EXEC 403 incl. RLS-404 caveat, target-role-in-state 400, VISITED-lane happy path, audit before/after, no-op no-audit); bare-prisma CI guardrail (scripts/check-bare-prisma.mjs + guardrails job - tamper-verified exit 1 on planted violation; ALLOWLIST documents the 5 sanctioned bare-client paths). Gates: backend 646, RLS 135, type-check clean.
- [ ] **T-G2 (P1, human ~2h / CC ~15min)** - database - Fix reminder_select_manager team leak + unset-var deny-all hardening across policies
  - Surfaced by: eng G-2/G-3 - Files: packages/database/prisma/rls/policies.sql
  - Verify: RLS matrix negative cases
- [ ] **T-G4 (P1, human ~2h / CC ~20min)** - backend - Cron lease renewal + status-claim idempotency + owned-token release
  - Surfaced by: eng G-4 - Files: apps/backend/src/reminders/processor
  - Verify: processor test: tick > 60s does not double-fire
- [ ] **T-G5 (P1, human ~4h / CC ~30min)** - repo - CI workflow (lint+typecheck+test) + first Prisma migration that applies policies.sql + root scripts docker:up/db:policies/setup
  - Surfaced by: eng G-5 + DX X-1/X-6 - Files: .github/workflows/ci.yml, packages/database/prisma/migrations, package.json scripts
  - Verify: green CI on scaffold push
- [ ] **T-X1 (P2, human ~3h / CC ~30min)** - repo - Root README.md + complete .env.example + root AGENTS.md (real conventions)
  - Surfaced by: DX X-1/X-2/X-6 - Files: README.md, .env.example, AGENTS.md
  - Verify: fresh-clone walkthrough hits zero surprises
- [ ] **T-X3 (P2, human ~2h / CC ~15min)** - backend - Boot fail-fast: REDIS_URL, JWT_SECRET, BETTER_AUTH_URL, PgBouncer reachability; compose healthcheck for pgbouncer
  - Surfaced by: DX X-3 + eng G-8 - Files: apps/backend/src/main.ts, boot-check.ts, docker-compose.yml
  - Verify: kill Redis in compose → boot fails with named fix
- [ ] **T-E2b (P2, human ~1h / CC ~10min)** - backend - Push receipt systematic-FAILED alert to Telegram + unit test
  - Surfaced by: CEO §2 registry - Files: apps/backend/src/notifications
  - Verify: threshold test fires alert
- [ ] **T-S (P2, human ~1h / CC ~15min)** - database+backend - Seed hardening: mustChangePassword + no default login until rotated
  - Surfaced by: CEO §3 - Files: packages/database/src/seed.ts, auth flows
  - Verify: seed integration test
- [ ] **T-RLSREAL (P2, human ~6h / CC ~45min)** - database - Make the 128-case RLS matrix real (PG test service, procedure-generated cases, unset-var negatives)
  - Surfaced by: DX X-5 + eng #10 - Files: packages/database/test/rls-isolation.test.ts, docker-compose.yml
  - Verify: pnpm test runs 128 cases
- [ ] **T-DOC (P2, human ~4h / CC ~30min)** - docs - ARCHITECTURE.md W2, RUNBOOK.md W3, DEPLOY.md W4 (per DX cadence)
  - Surfaced by: DX X-4 - Files: 4 root docs
  - Verify: doc review in weekly ship
- [ ] **T-G6G7 (P3, human ~1h / CC ~5min)** - plan - Sync §6 auth sketch (drop apiKey()) + role casing to UPPERCASE enum values
- [ ] **T-ARM (P1, human ~5h / CC ~40min)** - backend+schema - ManagerAssignmentRule engine per §18: priority-ordered evaluation (source/project/phase/language/region), catch-all, team defaultAssigneeId fallback, unassigned+manager-notified end state; +schema migration dropping @@unique([teamId, source]); +6 tests named in §18
  - Surfaced by: user direction 2026-08-31 (both manual + situational auto-assign) - Files: packages/database/prisma/schema.prisma, apps/backend/src/leads/leads.service.ts, Admin UI rules page
  - Verify: unit tests for priority/catch-all/fallback chain + integration test of lead-create routing


### `ManagerAssignmentRule` schema delta (from same decision, Week 2)
Current scaffold model matches source-only routing. To support the situation criteria above, extend in the first migration:

```prisma
model ManagerAssignmentRule {
  id           String   @id @default(cuid())
  teamId       String
  priority     Int      @default(100) // lower = evaluated first
  source       String?  // exact match, optional
  projectId    String?  // optional
  phaseId      String?  // optional
  language     String?  // optional
  region       String?  // optional
  targetUserId String
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@index([teamId, priority, active])
  @@index([targetUserId])
}

model Team {
  // ...existing fields...
  defaultAssigneeId String? // no-match fallback assignee
}
```

Breaking change from scaffold's `@@unique([teamId, source])` - drop it (multiple rules per source at different priorities are now legitimate). `source` becomes nullable for catch-all rules.

---


## SECOND-ROUND AUDIT - 2026-08-31 (Agency specialists: code-reviewer, test-automation-engineer, codebase-archaeologist)

Post-gate sweep of the scaffold at commit f1d77f7. All claims verified line-by-line by the primary
before acceptance. One specialist finding (compose DB URLs "***" = broken URI) was REJECTED after
raw-byte verification - it was an artifact of secret masking in tool display, the file is valid.

### New critical/high findings (folded into plan tasks)

| # | Finding | Evidence | Sev | Task |
|---|---------|----------|-----|------|
| AR-1 | **Owner-role RLS bypass**: app connects as Postgres table owner (`POSTGRES_USER: shadhil`), which bypasses RLS entirely; no `FORCE ROW LEVEL SECURITY`, no non-owner app role in `docker/postgres-init/00-init.sql` | policies.sql grep; 00-init.sql is a 10-line no-op | critical | T-G2 (amend: FORCE RLS + app role + GRANTs, not just policy edits) |
| AR-2 | **JWT role-casing breaks RLS end-to-end**: `packages/auth-client/src/jwt.ts:12` types roles lowercase (`'sales_executive'`), schema/policies/seed are UPPERCASE (`SALES_EXEC`); verified md5-vs-SCRAM mismatch also exists in pgbouncer userlist vs `auth_type = scram-sha-256` (userlist has stale md5 hash of wrong password) | jwt.ts:12 vs schema.prisma:35-40, policies.sql:25 | critical | T-G7 (upgrade to: normalize role casing at issuance + in withRlsContext; regenerate SCRAM verifier) |
| AR-3 | **CI in wrong directory**: 3 workflows live in `apps/web/.github/workflows/` - GitHub only reads root `.github/` in a monorepo; nothing gates PRs | ls .github (root) = absent | high | T-G5 (move + fix paths) |
| AR-4 | **Turbo caches stale test passes**: `tasks.test.inputs` excludes `**/*.test.ts(x)` - editing tests doesn't invalidate cache | turbo.json test task | critical | T-G5b (drop the two `!` exclude lines) |
| AR-5 | **Backend tests vacuously green**: `passWithNoTests: true` + zero test files - verified live ("No test files found, exiting with code 0") | apps/backend/vitest.config.ts | critical | T-RLSREAL + set passWithNoTests:false once first real test lands |
| AR-6 | **withRlsContext is wired nowhere in apps**: jwt-guard comment references a nonexistent `rls.interceptor.ts`; no instrumentation.ts for web boot-check | grep apps/backend/src | high | T-G1 (confirmed - interceptor must be built, not just documented) |
| AR-7 | **Audit read endpoint is @Public()** with decorative ApiBearerAuth; all stub controllers are @Public "temporarily" - trivial to ship real handlers still public | audit.module.ts, leads.module.ts:12 | high | T-SEC (new: strip @Public from stubs, lint rule banning it outside auth/webhooks) |
| AR-8 | **Dead/duplicate auth wiring**: `makeAuth()` in backend auth.module duplicates @shadhil/auth skipping assertAuthEnv; WhatsApp webhook GET doesn't echo hub.challenge; orphan JWT_SECRET (env requires, nothing consumes) | auth.module.ts, webhooks.module.ts | medium | T-G8 (consolidate single better-auth instance; webhook verify-token; drop or use JWT_SECRET) |
| AR-9 | **Playwright testDir missing** (`apps/web/src/test/e2e` doesn't exist) - config has webServer but nothing to run; E2E bed not stood up | playwright.config.ts:8 | high | T-G5 scope (add smoke spec + testcontainers PG helper) |
| AR-10 | **Starter boilerplate left behind**: `apps/web/docker-compose.yml` (Supabase/Sentry/PostHog), empty untracked `infra/`, seed.ts writes scrypt `password` column better-auth doesn't read | file inspection | low/medium | T-CLEAN (delete/fix; seed via better-auth API) |

### Verification notes
- CONFIRMED: FORCE RLS absent; jwt role lowercase; userlist md5 ≠ scram requirement (computed md5 differs);
  CI in wrong root; turbo test-input excludes; passWithNoTests vacuous pass; @Public stubs; testDir missing.
- REJECTED: compose DATABASE_URL "invalid URI" (mask artifact - raw bytes show shadhil:shadhil@, valid).
- CORRECTED from first review: "no CI" was wrong in kind - CI exists in the wrong directory (same net effect: never runs).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | /plan-ceo-review via /autoplan | Scope & strategy | 1 | issues_found | 3 challenged premises (consensus-confirmed), 3 GAPs in error/rescue, alternatives table shallow |
| Design Review | /plan-design-review via /autoplan | UI/UX gaps | 1 | issues_found | 8 findings: 2 critical (offline outcomes, contrast), 2 taste |
| DX Review | /plan-devex-review via /autoplan | Developer experience | 1 | issues_open | 6/6 confirmed: TTHW 20-30min, no README/.env.example/AGENTS.md/CI, RLS matrix unreachable |
| Eng Review | /plan-eng-review via /autoplan | Architecture & tests (required gate) | 1 | issues_open | 10 findings: 3 critical (RLS bypass architecture, policy fail-open, policies never applied), cron dup-fire, reassign atomicity |
| Codex Review | codex exec (ollamacloud via OmniRoute) | Independent 2nd opinion | 4 passes | issues_found | CEO 7, Design 8, DX 6, Eng 10 |

- **CODEX:** 4 voice passes ran (all model `ollamacloud/glm-5.3-flash` via local OmniRoute gateway). All
  code-level claims verified against the repo before acceptance.
- **CROSS-MODEL:** Agreement on: app-store risk, RLS policy hardening, CI/migration gap, contrast failure,
  offline-outcome gap, docs. Disagreement: Codex eng voice leaned toward cutting mobile scope - rejected
  (user-locked decision, P2 conflict-resolution).
- **VERDICT:** Eng review (the required shipping gate) = **issues_open - 3 critical architecture/data
  findings, all with auto-approved fixes wired into the task list.** Plan is NOT yet implement-start
  clean; fix T-G2/T-G5/T-RLSREAL (a day of CC work) before Week 1 RLS verification gate.

**UNRESOLVED DECISIONS:**


**RESOLVED at Final Approval Gate (2026-08-31, user approved as-is with recommendations):**
1. ~~USER CHALLENGE 1~~ RESOLVED: NEW→Sales-Exec reassign = explicit Model C exception (audit `exception: 'NEW_TO_EXEC'`, canTransition unchanged, dedicated test) - amendment written into §18.
2. ~~USER CHALLENGE 2~~ RESOLVED: Apply WCAG AA token fixes (T-D8 in scope). D8 contrast computation triple-confirmed (2 subagent passes + codex design voice: amber 1.97:1, green 3.03:1, red 4.44:1 vs #f8f5ef).
3. ~~USER CHALLENGE 3~~ RESOLVED: Week 7 store-review gate + 2-week buffer adopted - amendment written into Phase 7.
4. ~~TASTE 1~~ RESOLVED: Keep Lead Inbox with Decision 0.2 sort - dedicated telecaller call-queue surface NOT added.
