# Client Feedback Round 10 — 2026-08-29 (Shadhil CRM)

You asked: "Add push notification for staff for both web and mobile."

Real feature, not a clarification. The v2 brief §10 already covers
push for ONE trigger (lead assignment). The user is asking for the
FULL push notification system, covering all staff events, on both
web and mobile.

This delta replaces the §10 stub with a complete push notification
design.

---

## TL;DR

Adding a complete cross-platform push notification system for
staff. Uses **Expo Push as the universal push service** so web,
iOS, and Android all share the same backend API, payload format,
and push token storage.

12 distinct staff triggers, all going through the same push
infrastructure. Each trigger has:
  - Who receives (specific user, role, or team)
  - What they see (title, body, icon, click target)
  - When they get it (real-time, batched, snoozed, etc.)
  - Quiet hours respect (no push 22:00-07:00 local time)
  - Audit log entry

**One push service. Three surfaces (web, iOS, Android). One
schema. One cron.** Real-world cross-platform patterns baked in.

---

## Why Expo Push as the universal service

The naive approach is three separate push services:
- APNs (Apple Push Notification service) for iOS
- FCM (Firebase Cloud Messaging) for Android
- Web Push API + VAPID for web

That means three SDKs, three sets of credentials, three
delivery paths, three sets of errors to handle. Painful.

**Expo Push abstracts all three behind one API:**
- `expoPushToken` format works for iOS, Android, and web
- One backend call sends to all three
- Expo routes to APNs/FCM/Web Push based on the token
- Free for reasonable volume; 1000+ pushes/month is free tier

The trade-off: you're depending on Expo's infrastructure.
Mitigation: Expo's push service is in the Expo Cloud, has
99.9% SLA, and the same push can be sent directly to APNs/FCM
as a fallback if Expo has an outage. The fallback is a
3-day coding task in v1.1 if you ever want to remove the
dependency.

For v1: Expo Push is the right call. Saves 1-2 weeks of
multi-platform push setup.

---

## The 12 staff triggers

Each trigger is a code path in the NestJS backend. When the
event happens (lead assigned, handoff done, etc.), the
backend:

1. Identifies the recipient(s) (1+ user IDs)
2. Builds the push payload (title, body, data for deep link)
3. Sends to Expo Push API with all the recipients' tokens
4. Expo Push routes to APNs/FCM/Web Push as appropriate
5. Logs the push to `PushNotification` table + AuditLog

| # | Trigger | Recipients | Title | Body | Click target |
|---|---|---|---|---|---|
| 1 | New lead assigned to me | The assigned telecaller | "New lead: {{name}}" | "{{phone}} · {{source}}" | `/leads/{id}` |
| 2 | Lead handed off to me (manager) | The manager | "Handoff: {{lead.name}}" | "Telecaller {{user.name}} handed off a lead" | `/leads/{id}` |
| 3 | Lead handed off to my team | All managers in the team | "Team handoff" | "{{user.name}} handed off a lead to your team" | `/leads/{id}?team=mine` |
| 4 | Lead assigned to me (exec) | The assigned exec | "New lead for you" | "Manager {{user.name}} assigned a lead" | `/leads/{id}` |
| 5 | Site visit in 2 hours (pre-visit staff) | The sales exec | "Site visit soon" | "{{lead.name}} in 2 hours at {{time}}" | `/leads/{id}/visits/{visitId}` |
| 6 | Site visit no-show | Sales exec + manager | "No-show: {{lead.name}}" | "Visit at {{time}} — no outcome logged" | `/leads/{id}/visits/{visitId}` |
| 7 | Customer replied to chat (when staff is away) | Lead's current owner | "{{lead.name}} replied" | "{{message preview, truncated 80 chars}}" | `/leads/{id}#chat` |
| 8 | Booking awaiting my approval | The manager | "Booking: {{lead.name}}" | "{{unit.number}} · ₹{{token.amount}}" | `/leads/{id}/bookings/{bookingId}` |
| 9 | Booking approved / rejected | The sales exec | "Booking approved" or "Booking needs changes" | "{{unit.number}} · {{reason}}" | `/leads/{id}/bookings/{bookingId}` |
| 10 | Customer rescheduled the visit | Sales exec (or telecaller if pre-handoff) | "Reschedule: {{lead.name}}" | "New time: {{newTime}}" | `/leads/{id}/visits/{visitId}` |
| 11 | Mentioned in a note or chat | The mentioned user | "{{user.name}} mentioned you" | "{{context, truncated 100 chars}}" | `/leads/{id}#note-{noteId}` or `#msg-{msgId}` |
| 12 | Daily summary at 8 AM | Manager + admin (opt-out) | "Yesterday's summary" | "{{n}} new leads, {{m}} visits, {{k}} bookings" | `/dashboard` |

Triggers 5, 6, 10 are the reminder-driven ones (v9).
Triggers 1, 2, 3, 4, 8, 9 are state-transition ones.
Triggers 7, 11 are chat/mention ones.
Trigger 12 is the daily summary.

All 12 use the same push infrastructure.

---

## The data model

```prisma
// Per-user push token (one user can have multiple — phone, tablet, browser, etc.)
model PushSubscription {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  
  // Expo push token (works for iOS, Android, Web)
  expoPushToken String @unique
  
  // Platform metadata (for analytics + targeted features)
  platform    PushPlatform  // IOS, ANDROID, WEB
  deviceName  String?       // "iPhone 15 Pro", "MacBook Safari", etc.
  appVersion  String?       // "1.0.0"
  
  // Lifecycle
  isActive    Boolean  @default(true)
  lastSeenAt  DateTime @default(now())
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@index([userId, isActive])
  @@index([expoPushToken])
}

enum PushPlatform {
  IOS
  ANDROID
  WEB
}

// Every push sent (for audit + dedup + analytics)
model PushNotification {
  id              String   @id @default(cuid())
  
  // What triggered this push
  triggerType     String   // "lead.assigned", "site_visit.pre_visit", etc.
  triggerRefId    String?  // leadId, siteVisitId, etc. for dedup
  
  // Who received it
  userId          String
  user            User     @relation(fields: [userId], references: [id])
  subscriptionId  String?
  subscription    PushSubscription? @relation(fields: [subscriptionId], references: [id])
  
  // Content
  title           String
  body            String
  data            Json?   // { leadId, visitId, deepLink, etc. }
  
  // Delivery
  status          PushStatus @default(PENDING)
  sentAt          DateTime?
  deliveredAt     DateTime?
  clickedAt       DateTime?
  failedAt        DateTime?
  errorMessage    String?
  
  // Quiet hours
  suppressedByQuietHours Boolean @default(false)
  rescheduledFor         DateTime?
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  @@index([userId, createdAt])
  @@index([triggerType, triggerRefId])  // dedup
  @@index([status, scheduledFor])       // cron picks pending pushes
}

enum PushStatus {
  PENDING       // waiting to send (e.g., quiet hours)
  SENT          // sent to Expo Push
  DELIVERED     // confirmed delivered to device (Expo receipt)
  CLICKED       // user tapped the push
  FAILED        // send failed
  CANCELLED     // superseded (e.g., lead assigned, then reassigned)
}
```

Also add to `User`:
```prisma
model User {
  // ... existing fields
  pushSubscriptions PushSubscription[]
  pushNotifications PushNotification[]
  
  // Reminder/push settings (from v9, kept consistent)
  pushSettings     Json?  // { quietHoursStart, quietHoursEnd, dailySummaryOptIn, etc. }
}
```

---

## The push flow (end-to-end)

### Step 1: User grants permission + registers token

**On web:**
- Service worker registered in the app
- User clicks "Enable notifications" in Settings
- Browser requests permission
- On grant: `expoPushToken` is created via `expo-notifications` web helpers
- Frontend sends the token to backend (`POST /push/subscribe`)
- Backend stores in `PushSubscription` table

**On iOS:**
- Expo app requests permission at first launch (configurable)
- Expo push token is created automatically by the Expo client
- Expo SDK sends the token to backend
- Backend stores it

**On Android:**
- Same as iOS. Expo handles FCM token registration.

### Step 2: Backend sends a push

When trigger N fires (e.g., lead assigned to telecaller), the
backend:

```typescript
// src/push/push.service.ts
async sendTriggerPush(trigger: PushTrigger) {
  // 1. Identify recipients
  const recipients = await this.identifyRecipients(trigger);
  
  // 2. Look up their push subscriptions
  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      userId: { in: recipients.map(r => r.userId) },
      isActive: true,
    },
  });
  
  if (subscriptions.length === 0) {
    // No devices registered — fall back to in-app only
    return;
  }
  
  // 3. Check quiet hours
  const now = new Date();
  const messages = subscriptions.map(sub => {
    const userSettings = sub.user.pushSettings || {};
    const isQuiet = isInQuietHours(now, userSettings);
    
    return {
      to: sub.expoPushToken,
      title: trigger.title,
      body: trigger.body,
      data: trigger.data,
      sound: 'default',
      badge: 1,
      // If quiet hours: schedule for the start of next active hours
      ...(isQuiet && { 
        // Expo doesn't have a "send at" parameter; we handle in our cron
      }),
    };
  });
  
  // 4. Send via Expo Push API
  const result = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  
  // 5. Log to PushNotification table
  for (const sub of subscriptions) {
    await prisma.pushNotification.create({
      data: {
        triggerType: trigger.type,
        triggerRefId: trigger.refId,
        userId: sub.userId,
        subscriptionId: sub.id,
        title: trigger.title,
        body: trigger.body,
        data: trigger.data,
        status: 'SENT',
        sentAt: new Date(),
        suppressedByQuietHours: false,  // computed in cron
      },
    });
  }
}
```

### Step 3: Quiet hours

If the user is in quiet hours (default 22:00-07:00 local
time), the push doesn't fire. Instead, it goes into a
`PENDING` state with `rescheduledFor` set to the start of
the next active window. The reminder cron picks it up then.

For staff triggers (real-time events like lead assigned),
we do NOT delay for quiet hours. The push fires anyway;
the user just doesn't see it until they look at their
phone. The PUSH is the record; the user chooses to look.

For reminder triggers (pre-visit, no-show, reschedule
follow-up), we DO respect quiet hours because they're
time-flexible.

**Logic:**
```typescript
function shouldRespectQuietHours(trigger: PushTrigger): boolean {
  return [
    'site_visit.pre_visit',
    'site_visit.no_show',
    'site_visit.reschedule',
    'reminder.reschedule_followup',
  ].includes(trigger.type);
}
```

### Step 4: Web Push specific

Web Push is a special case because:
- iOS Safari only supports Web Push for home-screen-installed PWAs
- Chrome/Edge/Firefox support Web Push for normal browser tabs
- Service worker must be registered
- VAPID keys must be configured

For our v1 (web = Next.js, not yet a PWA), the simplest
implementation:
- Web app requests notification permission on user action
- (Optional) The web app can be installed as a PWA via
  "Add to home screen" for better iOS Safari support
- Web push works for the user, regardless of PWA install

For the CRM's "every agent uses the app" requirement,
**the web app's push is a nice-to-have. Mobile push is
the must-have.** Field agents will use the mobile app
primarily; web is for managers and admin.

If we want iOS Safari push to work fully, the web app
needs to be a PWA. Recommend: ship web as PWA from day 1
(per the v2 brief §5 — "PWA in v1"). PWA gives iOS
home-screen + Web Push support.

### Step 5: Push receipt handling

Expo Push sends back receipts that confirm delivery.
We poll the receipt endpoint every 5 minutes for any
push we sent in the last 10 minutes:

```typescript
@Cron('*/5 * * * *')
async pollPushReceipts() {
  const recent = await prisma.pushNotification.findMany({
    where: {
      status: 'SENT',
      sentAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
    take: 100,
  });
  
  for (const push of recent) {
    const receipt = await fetch(
      `https://exp.host/--/api/v2/push/getReceipts`,
      {
        method: 'POST',
        body: JSON.stringify({ ids: [push.expoPushId] }),
      }
    );
    // Update push status based on receipt
  }
}
```

Failed pushes are retried (3 attempts, exponential backoff)
or marked FAILED and alerted.

---

## What this changes in DESIGN.md

When applied:

- §2 modules: NO new module. Push notifications are part of
  the existing Notifications subsystem (cross-cutting, not
  a module).
- §5 entities: add `PushSubscription` and `PushNotification`
  models. Add `pushSubscriptions` and `pushNotifications`
  relations to `User`.
- §6 integrations: add Expo Push (already mentioned in
  §10) as the primary push service. Add Web Push (VAPID)
  for web. Add the 12 triggers as a list.
- §10 Push notifications: REPLACE the existing §10 stub
  with this complete design.
- §12 timeline: add 0.5 week (push was already in the v2
  timeline, this just makes it more comprehensive). Total
  stays at 12 weeks.

---

## What this does NOT change

- §2 modules list (Reminders is still module 7, Audit Log
  is module 8)
- §3 lifecycle state machine
- §4 RBAC matrix
- §7 stack (Expo Push was already mentioned)
- The Reminders module from v9
- The 16 resolved client questions

---

## The one choice to surface to the client

**Choice: Daily summary push (trigger #12).**

Should the manager get a push at 8 AM every day with
yesterday's summary? Some managers love it (passive
oversight). Others find it annoying (one more thing in
their inbox). Recommend: opt-in, default off. Surface
to client.

---

## Two real reliability concerns

### Concern 1: Push delivery is not 100%

Expo Push is ~99% reliable. APNs and FCM are both 99%+
individually. Web Push is more like 95% (browser may
close, OS may throttle). For a CRM where missing a push
could mean a missed lead, we need:

- In-app SSE banner as the PRIMARY surface (always works
  when app is open)
- Push as the FALLBACK when app is closed
- Email as the LAST fallback (per v9 design)

The system should NEVER depend on push alone for critical
alerts. The push is a duplicate of the in-app notification.

### Concern 2: Token rotation

Push tokens change:
- iOS: rarely, but on app reinstall
- Android: every time FCM token is refreshed
- Web: when the service worker is unregistered, or the
  user clears browser data

The backend must handle this:
- On token registration, if the token already exists,
  update `lastSeenAt` and `isActive = true`
- If a push fails with "InvalidToken" or "DeviceNotRegistered",
  mark the subscription as `isActive = false`
- Periodic cron reaps subscriptions with `isActive = false`
  for 30+ days

---

## What I'd push back on

### Don't add MORE triggers without measuring

12 triggers is a lot. The CRM will feel "noisy" if every
event pings the staff. Recommend:
- v1 ships triggers 1-10 (the operational ones)
- Trigger 11 (mentions) deferred to v1.1
- Trigger 12 (daily summary) opt-in, default off
- v1.1 adds: SLA breach, target/goal alerts, customer
  birthday, anniversary of last contact

If Shadhil complains about "too many notifications" after
v1 launch, the right answer is per-trigger settings
(turn off trigger X, keep Y), not removing triggers.

### Don't use Web Push as the only notification channel

Web Push is the LEAST reliable of the three. iOS Safari
only supports it for installed PWAs. Chrome and Firefox
are good. Always pair push with in-app SSE banner so the
user sees it in the app even if push fails.

---

## Next step

If you're happy with this design, say "apply" and I'll
fold v10 (push notification system with 12 triggers) +
v9 (Reminders module) + the CLIENT-DECISIONS.md (16
resolved questions) into DESIGN.md v3 in one pass.

The new v3 will have:
  - §2 modules (8 modules, including new Reminders)
  - §5 entities (14 models, including new Reminder,
    PushSubscription, PushNotification, plus better-auth
    Account + Verification from v8)
  - §6 integrations (Expo Push as primary, Web Push as
    web fallback, email as last-resort fallback)
  - §10 push notifications (full design with 12 triggers)
  - §12 timeline (12 weeks)
  - §13 open questions: REMOVED (all resolved)
  - New: §15 Notification triggers table (the 12 triggers)
  - New: §16 Push reliability design (token rotation,
    quiet hours, fallback chain)
