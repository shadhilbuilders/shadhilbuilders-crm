# Client Feedback Round 13 — 2026-08-29 (Shadhil CRM)

You asked: "Store notifications and show it in the crm app both
web and mobile."

Real feature, not a clarification. The v10 push notification
system covers the OUTBOUND side (we send push). The user is
asking for the INBOUND side (user sees their notifications in
the app, in an inbox-style list).

This delta adds the **notification center** — the persistent
in-app inbox for all notifications on both web and mobile.

---

## TL;DR

Adding a **Notification Center** to v1:

- A new **`Notification` table** (separate from v10's
  `PushNotification` audit log) that stores every notification
  the user receives, with `readAt` / `dismissedAt` state.
- A **bell icon** in the top nav (web) and tab bar (mobile)
  with an **unread count badge** that updates in real time
  via SSE.
- A **dropdown panel** (web) and **full screen** (mobile) that
  lists all notifications, newest first, filterable by
  status (all / unread / by type).
- A **`GET /notifications`** REST endpoint + a real-time
  SSE channel for new notifications.
- **90-day visibility retention** in the inbox, 7-year
  retention in the database (matches audit log).

All 12 triggers from v10 automatically create `Notification`
rows. The user's inbox IS the visible record of what
happened to them.

---

## Why a separate `Notification` table

The v10 design has a `PushNotification` table. That's the
audit log for OUTBOUND pushes (what we sent, delivery status,
Expo receipt). It's append-only — never mutated after creation.

The inbox is a different thing. It needs:
- `readAt` (mutable, set when user clicks)
- `dismissedAt` (mutable, set when user dismisses)
- `recipientUserId` (one per user, not per device)
- Soft state, mutable over time

If I reused `PushNotification` for the inbox, I'd have to
add mutable fields to an audit log, which is a bad pattern
(loses the append-only guarantee for compliance).

**Cleaner:** Two tables.
- `PushNotification` — what we sent (audit, append-only)
- `Notification` — what the user sees (mutable state)

Relationship: one `Notification` row can have 0+ `PushNotification`
rows (one per device the push was sent to). Created in the
same transaction so they always match.

---

## The data model

```prisma
// User-facing inbox. Mutable state.
model Notification {
  id            String   @id @default(cuid())
  
  // Who receives
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  
  // What type of event (mirrors PushTrigger types for consistency)
  type          String   // "lead.assigned", "site_visit.pre_visit", etc.
  category      NotificationCategory  // LEAD, VISIT, BOOKING, SYSTEM, CHAT
  
  // Content
  title         String
  body          String
  icon          String?  // icon name (lucide-react on web, lucide-react-native on mobile)
  
  // Deep link target
  deepLink      String?  // "/leads/abc123", "/leads/abc/visits/xyz", etc.
  
  // Reference to the source entity (for filtering, deep linking, dedup)
  refType       String?  // "Lead", "SiteVisit", "Booking", "Message"
  refId         String?
  
  // State
  readAt        DateTime?
  dismissedAt   DateTime?
  archivedAt    DateTime?  // v1.1
  
  // Audit
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  
  // Indexes
  @@index([userId, readAt, createdAt(sort: Desc)])  // inbox query
  @@index([userId, createdAt(sort: Desc)])
  @@index([userId, category, createdAt(sort: Desc)])
  @@index([userId, dismissedAt, createdAt(sort: Desc)])
  @@index([type, refId])  // dedup
}

enum NotificationCategory {
  LEAD       // lead assigned, handed off, reassigned
  VISIT      // site visit pre/no-show/reschedule
  BOOKING    // booking approval, status change
  CHAT       // customer replied, mentioned
  SYSTEM     // daily summary, system events
}

// Push audit log. Append-only.
model PushNotification {
  // ... (from v10, unchanged)
  // Add a soft relation to Notification
  notificationId String?
  notification   Notification? @relation(fields: [notificationId], references: [id])
}
```

---

## The flow

### When an event happens (any of the 12 triggers)

```typescript
// src/notifications/notification.service.ts
async createAndDeliver(input: {
  userId: string;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  icon?: string;
  deepLink?: string;
  refType?: string;
  refId?: string;
}) {
  // 1. Dedup check: don't create duplicate if same type+refId in last 5 min
  const recent = await prisma.notification.findFirst({
    where: {
      userId: input.userId,
      type: input.type,
      refId: input.refId,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
  });
  if (recent) {
    return recent;  // skip duplicate
  }
  
  // 2. Create Notification row
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      category: input.category,
      title: input.title,
      body: input.body,
      icon: input.icon,
      deepLink: input.deepLink,
      refType: input.refType,
      refId: input.refId,
    },
  });
  
  // 3. Publish to Redis pub/sub for real-time delivery (in-app SSE)
  await redis.publish(
    `user:${input.userId}:notifications`,
    JSON.stringify(notification)
  );
  
  // 4. Update unread count cache
  await this.incrementUnreadCount(input.userId);
  
  // 5. Trigger push delivery (v10 service)
  await pushService.sendTriggerPush({
    type: input.type,
    userId: input.userId,
    title: input.title,
    body: input.body,
    data: { notificationId: notification.id, deepLink: input.deepLink },
  });
  
  // 6. Create PushNotification rows (one per device, populated async by v10)
  // ... (handled inside pushService)
  
  return notification;
}
```

### When the user opens the app or navigates to /notifications

```typescript
// GET /notifications?limit=20&offset=0&filter=unread
async listNotifications(userId: string, filter: string, limit: number, offset: number) {
  const where: any = {
    userId,
    OR: [
      { dismissedAt: null },
      // Show recently dismissed (last 24h) in case user wants to undo
      { dismissedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    ],
    // 90-day visibility retention
    createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
  };
  
  if (filter === 'unread') {
    where.readAt = null;
    where.dismissedAt = null;
  } else if (filter !== 'all') {
    where.category = filter.toUpperCase();
  }
  
  return prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}
```

### When the user clicks a notification

```typescript
// POST /notifications/:id/read
async markAsRead(userId: string, notificationId: string) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  
  if (!notification || notification.userId !== userId) {
    throw new NotFoundException();
  }
  
  if (notification.readAt) {
    return notification;  // already read, no-op
  }
  
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  
  // Decrement unread count cache
  await this.decrementUnreadCount(userId);
  
  // Publish to Redis for real-time UI update (unread badge)
  await redis.publish(
    `user:${userId}:notifications:read`,
    JSON.stringify({ id: notificationId, readAt: updated.readAt })
  );
  
  return updated;
}
```

### When the user clicks "Mark all as read"

```typescript
// POST /notifications/read-all
async markAllAsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
      dismissedAt: null,
      createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
    data: { readAt: new Date() },
  });
  
  // Reset unread count cache
  await this.resetUnreadCount(userId);
  
  // Publish to Redis for real-time UI update
  await redis.publish(
    `user:${userId}:notifications:read-all`,
    JSON.stringify({ count: result.count })
  );
  
  return { count: result.count };
}
```

---

## The real-time delivery (SSE)

A new SSE endpoint, separate from the chat SSE (per leadId
channel). This one is per-userId:

```typescript
// GET /notifications/stream
// Server-Sent Events stream of all notification events for the logged-in user
async notificationsStream(@Req() req, @Res() res) {
  const userId = req.user.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Authenticate via JWT in query param (SSE doesn't support custom headers)
  // ... (same pattern as chat SSE)
  
  // Subscribe to user's notification channel
  const subscriber = redis.duplicate();
  await subscriber.subscribe(`user:${userId}:notifications`);
  await subscriber.subscribe(`user:${userId}:notifications:read`);
  await subscriber.subscribe(`user:${userId}:notifications:read-all`);
  
  subscriber.on('message', (channel, message) => {
    res.write(`event: notification\n`);
    res.write(`data: ${message}\n\n`);
  });
  
  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);
  
  // Cleanup on disconnect
  req.on('close', async () => {
    clearInterval(heartbeat);
    await subscriber.unsubscribe();
    await subscriber.quit();
  });
}
```

Three Redis channels per user:
- `user:{id}:notifications` — new notification created
- `user:{id}:notifications:read` — single notification marked read
- `user:{id}:notifications:read-all` — all marked read (reset badge)

---

## The unread count cache

The bell icon needs the unread count on every page load. Querying
Postgres on every page load is wasteful. Cache in Redis with
5-minute TTL:

```typescript
async getUnreadCount(userId: string): Promise<number> {
  const cacheKey = `user:${userId}:unread_count`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return parseInt(cached, 10);
  
  const count = await prisma.notification.count({
    where: {
      userId,
      readAt: null,
      dismissedAt: null,
      createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
  });
  
  await redis.set(cacheKey, count.toString(), 'EX', 300);  // 5 min TTL
  return count;
}

async incrementUnreadCount(userId: string) {
  const key = `user:${userId}:unread_count`;
  await redis.incr(key);
  await redis.expire(key, 300);
}

async decrementUnreadCount(userId: string) {
  const key = `user:${userId}:unread_count`;
  const current = await redis.get(key);
  if (current && parseInt(current, 10) > 0) {
    await redis.decr(key);
  }
}

async resetUnreadCount(userId: string) {
  const key = `user:${userId}:unread_count`;
  await redis.del(key);
}
```

Cache invalidation happens on:
- New notification created (`increment`)
- Notification marked read (`decrement`)
- Notification marked dismissed (`decrement`)
- All marked read (`reset`)
- Notification older than 90 days expires (handled by TTL on cache + 24h cron for cleanup)

---

## The web UI

### Bell icon + badge in top nav

```
┌──────────────────────────────────────────────────────────────┐
│  [Logo]   [Dashboard]  [Leads]  ...              [🔔³]  [👤] │
│                                                    ▲        │
│                                              unread count  │
└──────────────────────────────────────────────────────────────┘
```

The bell icon is in the top nav, right side. Shows a red badge
with the unread count (capped at "9+"). On click, opens a
dropdown panel.

### Dropdown panel (slide from right)

```
┌────────────────────────────────────────┐
│  Notifications                  [×]    │
├────────────────────────────────────────┤
│  [All]  [Unread (3)]  [Leads]  [Visits]│
├────────────────────────────────────────┤
│ ● 🔔 New lead: Ravi Kumar             │
│        +91 98765 43210 · landing_site  │
│        2 minutes ago                  │
│                                        │
│   🔔 Site visit in 2 hours             │
│     Priya Sharma · Sat 3:00 PM          │
│     1 hour ago                         │
│                                        │
│ ● 🔔 Lead handed off to your team      │
│     Suresh · Just now                  │
│                                        │
│   [Mark all as read]   [See all →]     │
└────────────────────────────────────────┘
```

Filled circle `●` = unread. Click on item:
1. Marks as read (fires `POST /notifications/:id/read`)
2. Closes the panel
3. Navigates to the `deepLink` (e.g., `/leads/abc123`)

### Full page `/notifications`

When the user clicks "See all" in the dropdown, navigate to
`/notifications` for a full page view with:
- Same filter tabs at the top
- Larger list with more metadata
- Pagination (load more on scroll)
- Date grouping (Today / Yesterday / This week / Older)
- Empty states ("You're all caught up!")

### Real-time updates

The component subscribes to `GET /notifications/stream` on mount.
When a new notification arrives, it appears at the top with a
brief highlight animation (1-second yellow background, fades out).
Unread badge updates live.

---

## The mobile UI (Expo)

### Bell icon in tab bar

```
┌──────────────────────────────┐
│  [☰]  Notifications  [⚙]    │
├──────────────────────────────┤
│                              │
│  Today                       │
│  ┌────────────────────────┐ │
│  │ ● 🔔 New lead           │ │
│  │   Ravi Kumar            │ │
│  │   2 min ago             │ │
│  └────────────────────────┘ │
│                              │
│  ┌────────────────────────┐ │
│  │   🔔 Site visit in 2h   │ │
│  │   Priya Sharma          │ │
│  │   1h ago                │ │
│  └────────────────────────┘ │
│                              │
├──────────────────────────────┤
│ [🏠 Home] [👥 Leads] [🔔³] [...]│
│                            ▲ │
│                       unread badge│
└──────────────────────────────┘
```

Bell icon is the third tab in the tab bar. Unread badge shows
on the tab. Tapping the tab opens the notifications screen.

### Full screen `/notifications`

- Same list as web, but full screen
- Pull-to-refresh
- Tap item → marks as read + navigates
- Swipe left to dismiss (sliding animation)
- "Mark all as read" in the header
- Filter chips at the top (All / Unread / Leads / Visits / Bookings)
- Empty state with friendly illustration

### Real-time updates

Same SSE pattern as web. Component subscribes on mount, new
items appear at the top with a brief slide-in animation.

---

## What this changes in DESIGN.md

When applied:

- **§2 modules: ADD Notifications Center as a new module (8 → 9 modules).** Wait — the user wanted 8 modules max. Let me reconsider: should the inbox be a separate module, or part of the existing Notifications infrastructure? **Decision: part of the existing infrastructure, not a separate module.** The inbox is a UI surface, not a business module. The backend work is cross-cutting.
- **§5 entities: add `Notification` model** (separate from
  v10's `PushNotification`). Add `notifications` relation to
  `User`. Add soft relation from `PushNotification` to
  `Notification`.
- **§6 integrations: no new external integration.** All
  within our stack.
- **§9 Realtime chat (SSE):** mention the additional SSE
  channel for notifications (`user:{id}:notifications`).
- **§10 push notifications:** update to mention the
  Notification table is the source of truth for what the
  user sees, PushNotification is the audit log.
- **§12 timeline:** add 0.5 week for the notification
  center (UI on both web + mobile). New total: 12.5 weeks.
  Round to 13 weeks in the timeline.

---

## What this does NOT change

- §3 lifecycle state machine
- §4 RBAC matrix
- §7 stack
- The 12 push triggers from v10
- The 4 reminder types from v9
- The 16 resolved client questions
- §1 roles

---

## Real-world UX patterns I'm building in

### Grouping by date (not just one long list)

The full page groups notifications:
- **Today** (with timestamp like "2 min ago")
- **Yesterday** (with date)
- **This week** (with day name)
- **Older** (with date)

This is the standard Gmail / Slack / iOS pattern. Reduces
visual noise.

### "You're all caught up!" empty state

When the inbox is empty (no unread, or no notifications at
all), show a friendly empty state:
- Illustration (a sleeping cat or a "no notifications" icon)
- "You're all caught up!" message
- "We'll let you know when something needs your attention."

This is the Slack / Linear / Notion pattern. Reduces the
"empty inbox anxiety."

### Unread badge capped at "9+"

Don't show "47" in a tiny badge. Cap at 9, show "9+" beyond.
Standard pattern across iOS, Gmail, etc.

### Notification grouping for chat replies

If a customer sends 5 messages in 2 minutes, the user gets
5 separate chat notifications. That's noisy. Solution:
**grouping.** If 3+ notifications of the same type for the
same refId arrive within 5 minutes, collapse them into one:
- Title: "Priya Sharma sent 5 messages"
- Click: opens the chat at the latest message

This is an optional enhancement. v1 can ship without it
and add in v1.1 if Shadhil complains about noise.

### Deep link verification

Every notification has a `deepLink`. Before showing it,
the backend validates the link is reachable for this user
(if the lead was reassigned, the link should update). If
the link is stale, redirect to the dashboard.

For v1: skip this validation. The deep link is best-effort.
If the user clicks a stale link, they see a 404 or a "this
lead is no longer assigned to you" message. Both are
acceptable.

---

## Two real reliability concerns

### Concern 1: Unread count cache can drift

The Redis cache is incremented/decremented on every create/
read. If a process crashes mid-operation, the cache can be
out of sync with the database. Mitigation:
- 5-minute TTL means the cache re-queries Postgres within
  5 minutes even if it drifts
- Add a daily cron that recomputes the cache for all active
  users: `unreadCount = SELECT COUNT(*) FROM notification WHERE
  readAt IS NULL AND dismissedAt IS NULL`
- The cache is a performance optimization, not a source of
  truth. The DB is the source of truth.

### Concern 2: SSE connection storm on app open

If 10 users open the app at 8:00 AM (start of day), each
opens an SSE connection. Each connection subscribes to
3 Redis channels. That's 30 subscriptions. Redis can
handle 10K+ subscriptions easily, so this is fine. But
on the NestJS side, each SSE connection holds an open
HTTP response. With 50 users, that's 50 open responses.
With 200 users (v2), that's 200. NestJS handles this
fine (async I/O), but the connection pool to Postgres
gets used. Monitor for connection pool exhaustion.

For v1 (5-15 users): not a concern. For v2 (50-200): add
monitoring. For v3 (500+): may need to switch to a
dedicated SSE service (separate from NestJS).

---

## What I'd push back on

### The 90-day inbox visibility might be wrong

I picked 90 days as the inbox visibility window. The actual
right number depends on how often staff look at the inbox.
For a real estate sales team, 30 days is probably enough.
For an enterprise SaaS, 90 days. For a support tool, 7 days.

**Default: 90 days for v1. Make it configurable per user in
Settings. Re-evaluate based on actual usage data after
30 days in production.**

### Don't add notification PREFERENCES in v1

The temptation is to add "I want lead-assigned notifications
but not site-visit reminders" in v1. This is a real user
need, but it's also a UI rabbit hole (12 trigger types ×
4 channels × on/off = 48 settings per user).

**For v1: ship 12 triggers all on by default, with the
"Mark all as read" + "Dismiss" actions as the noise-control
mechanism. v1.1 adds per-trigger settings if Shadhil
complains about noise.**

### Don't add notification SOUNDS customization

Same rabbit hole. Default to system sound on all platforms.
v1.1 if needed.

---

## One choice to surface to the client

**Daily summary push (trigger 12 from v10) — does it ALSO
create an inbox entry?**

Two options:
- (a) Yes — daily summary creates a `Notification` row,
      visible in the inbox like any other
- (b) No — daily summary is push-only, lives in the email
      fallback, not in the inbox

**Default: (a) — yes, in the inbox. The inbox is the user's
single record of what happened. Push is just a delivery
mechanism. If the user opens the inbox, they should see
"Yesterday: 12 new leads, 3 visits, 1 booking" as the first
item.**

Surface to client for confirmation.

---

## Next step

If you're happy with this design, say "apply" and I'll
fold v11 (Notification Center + inbox) into DESIGN.md v3
along with v8, v9, v10, and CLIENT-DECISIONS.md.

The new v3 will have:
  - 9 modules in §2 (Notifications Center added as a
    cross-cutting infrastructure, not a separate module —
    but its UI is a first-class surface)
  - 15 models in §5 (Notification added; PushSubscription
    + PushNotification from v10; Reminder from v9; better-auth
    Account + Verification from v8; original 12 from v2)
  - §10 split into §10 (Push — outbound) and §11
    (Notification Center — inbox)
  - §12 timeline: 13 weeks (was 12)

If you want a different decision on any of the above
(daily summary in inbox, 90-day window, etc.), name it.
Otherwise, "apply" consolidates everything.
