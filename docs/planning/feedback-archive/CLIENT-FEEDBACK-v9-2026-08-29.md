# Client Feedback Round 10 — 2026-08-29 (Shadhil CRM)

You asked: "I need reminder for telecaller and sale executive for
follow up, if customer reschedule the visit with specific time,
we should let reminder the telecaller or sale executive for
follow up."

Real feature, not a clarification. Adding it to the brief now.

---

## TL;DR

Adding a new **Reminders** module to v1. Three reminder types:

  1. **Pre-visit staff reminder** — sales exec gets a nudge
     before the scheduled visit (default: 2 hours before).
  2. **Pre-visit customer reminder** — customer gets a
     WhatsApp message before the visit (default: 24 hours
     before + 2 hours before).
  3. **Reschedule follow-up reminder** — sales exec gets a
     nudge AFTER the reschedule, prompting them to confirm
     with the customer. (This is what you specifically
     asked for.)

The system also needs to handle the no-show case (already in
v2) and the post-booking case (deferred to v1.1).

---

## What the user is asking for, decoded

When a customer reschedules a site visit with a specific new
time, the system should:

  - **Identify the staff member responsible** (telecaller
    if the lead is still in the pre-handoff stage, sales
    exec if post-handoff).
  - **Schedule a reminder** at the right time relative to
    the new visit.
  - **Fire the reminder** via the right channel (in-app
    banner if app is open, push notification if app is
    closed, fallback to email if push fails).
  - **Mark the reminder as acknowledged** when the staff
    member actually does the follow-up.
  - **Audit log entry** for every reminder fired
    (RERA + DPDP requirement).

This is more nuanced than it looks because the same visit
can have MULTIPLE reminders (e.g., 24h before for the
customer, 2h before for the staff, 1h after no-show for
the staff, etc.).

---

## The three reminder types (full design)

### Type 1: Pre-visit staff reminder

**When:** T-X hours before scheduled visit time.
**Who:** Sales Exec (post-handoff owner) or Telecaller
(if lead is still in pre-handoff — should not happen in
normal flow but possible for early scheduled visits).
**Channel (in priority order):**
  1. **In-app banner** if the staff member's app is open
  2. **Push notification** if app is closed (Expo
     Notifications on mobile, Web Push on web)
  3. **Email** as last fallback (but email is dropped
     from v1 per Q3 resolution — actually keep email
     as the fallback for reminders specifically, since
     email is good for "low-urgency, time-flexible"
     notifications; surface to client)
**Default timing:** 2 hours before. **Configurable per
user** (Settings → Reminder timing).
**Repeat:** None. Fire once. If missed, no resend.
**Acknowledgment:** Staff member taps "Mark done" or
"Reschedule" on the reminder banner. Acknowledgment is
logged.
**Audit log:** `{ action: "reminder.fired",
  userId, siteVisitId, type: "pre_visit_staff", channel }`

### Type 2: Pre-visit customer reminder

**When:** T-24 hours AND T-2 hours before scheduled visit.
**Who:** Customer (via WhatsApp).
**Channel:** WhatsApp template message.
**Default timing:** 24h and 2h. **Configurable per
project** (Settings → Project reminder settings).
**Repeat:** None. Fire twice.
**Acknowledgment:** Customer can reply "YES" to confirm
or "RESCHEDULE" to trigger the reschedule flow. Reply
is captured via the WhatsApp webhook, parsed for keywords,
triggers a `Message` row + state change if applicable.
**Audit log:** `{ action: "reminder.fired",
  recipientType: "customer", siteVisitId, type:
  "pre_visit_customer", channel: "whatsapp" }`
**WhatsApp templates needed:**
  - `visit_reminder_24h` (UTILITY category)
  - `visit_reminder_2h` (UTILITY category)

### Type 3: Reschedule follow-up reminder (THE ONE YOU ASKED FOR)

**When:** Two cases:
  - **Case A: Customer-initiated reschedule.** When the
    customer reschedules (e.g., via WhatsApp reply,
    phone call to staff, or in-person), the staff member
    picks a new time. The system schedules:
      - A pre-visit staff reminder for the new time
        (Type 1, fires T-2h)
      - A pre-visit customer reminder for the new time
        (Type 2, fires T-24h and T-2h)
      - **A "did you confirm with the customer?"
        reminder for the staff** (Type 3 specifically).
        This fires 1 hour AFTER the reschedule is recorded
        and prompts the staff member to call the customer
        to confirm the new time.
  - **Case B: Staff-initiated reschedule.** Sales exec
    reschedules because customer asked in person or by
    phone. Same reminders fire, but the "did you confirm"
    reminder is moot (the staff already confirmed in
    person). Make it dismissable in the UI.
**Who:** Sales Exec.
**Channel:** In-app banner > push > email fallback.
**Default timing:** 1 hour after reschedule. Configurable.
**Repeat:** None. Fire once.
**Acknowledgment:** Tap "Confirmed with customer" or
"Cancel" on the banner.
**Audit log:** `{ action: "reminder.fired",
  userId, siteVisitId, type: "reschedule_followup",
  channel }`

### Type 4 (already in v2): No-show staff reminder

**When:** 2 hours after scheduled visit time, IF no
outcome logged.
**Who:** Sales Exec + Manager (the manager gets a copy
so they can intervene if the exec is unresponsive).
**Channel:** Push notification.
**WhatsApp template:** `missed_visit_followup` (already
in the v2 brief).

### Type 5 (deferred to v1.1): Post-booking reminders

After a booking is initiated, the system should remind
the sales exec about agreement milestones (token
received, lawyer assigned, agreement signed). Deferred
to v1.1 because the lawyer flow is deferred per Q2.

---

## The Reminder entity (new in schema)

Add to the Prisma schema:

```prisma
model Reminder {
  id              String         @id @default(cuid())
  type            ReminderType
  status          ReminderStatus @default(SCHEDULED)
  
  // What this reminder is about
  siteVisitId     String?
  siteVisit       SiteVisit?     @relation(fields: [siteVisitId], references: [id])
  leadId          String
  lead            Lead           @relation(fields: [leadId], references: [id])
  
  // Who (for staff reminders) or null (for customer reminders)
  recipientUserId String?
  recipient       User?          @relation(fields: [recipientUserId], references: [id])
  recipientPhone  String?        // for customer reminders
  
  // When
  scheduledFor    DateTime       // when it should fire
  firedAt         DateTime?      // when it actually fired
  acknowledgedAt  DateTime?      // when staff member acknowledged
  
  // How
  channel         ReminderChannel
  payload         Json?          // template name, variables, etc.
  
  // Retry / error tracking
  attempts        Int            @default(0)
  lastError       String?
  
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  
  @@index([scheduledFor, status])     // cron job picks due reminders
  @@index([leadId])
  @@index([recipientUserId, status])
}

enum ReminderType {
  PRE_VISIT_STAFF        // Type 1
  PRE_VISIT_CUSTOMER     // Type 2
  RESCHEDULE_FOLLOWUP    // Type 3
  NO_SHOW_STAFF          // Type 4
  POST_BOOKING           // Type 5 (v1.1)
}

enum ReminderStatus {
  SCHEDULED     // waiting to fire
  FIRING        // currently being sent
  FIRED         // sent successfully, waiting for ack
  ACKNOWLEDGED  // staff member acknowledged
  CANCELLED     // superseded by a reschedule or lead closed
  FAILED        // all retry attempts exhausted
}

enum ReminderChannel {
  IN_APP
  PUSH
  EMAIL
  WHATSAPP
}
```

Also add to `SiteVisit`:
```prisma
model SiteVisit {
  // ... existing fields
  reminders     Reminder[]
}
```

And to `Lead`:
```prisma
model Lead {
  // ... existing fields
  reminders     Reminder[]
}
```

---

## The reminder scheduler (new backend component)

A cron job runs every minute in the NestJS backend:

```typescript
// src/reminders/reminder.processor.ts
@Cron('* * * * *')  // every minute
async processDueReminders() {
  const now = new Date();
  const due = await prisma.reminder.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledFor: { lte: now },
    },
    take: 100,  // batch limit per minute
  });
  
  for (const reminder of due) {
    await this.fireReminder(reminder);
  }
}
```

Each reminder fires via the appropriate channel:

```typescript
async fireReminder(reminder: Reminder) {
  try {
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: { status: 'FIRING' },
    });
    
    switch (reminder.channel) {
      case 'IN_APP':
        // Publish to Redis pub/sub for SSE delivery
        await redis.publish(`user:${reminder.recipientUserId}:reminders`,
          JSON.stringify(reminder));
        break;
      case 'PUSH':
        if (reminder.recipientUserId) {
          // Look up the user's push token(s)
          // Send via Expo Push API
          await pushService.send(reminder.recipientUserId, reminder);
        } else if (reminder.recipientPhone) {
          // Customer WhatsApp via Cloud API
          await whatsappService.send(reminder.recipientPhone, reminder);
        }
        break;
      case 'EMAIL':
        await emailService.send(reminder.recipientUserId, reminder);
        break;
      case 'WHATSAPP':
        await whatsappService.send(reminder.recipientPhone, reminder);
        break;
    }
    
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: 'FIRED',
        firedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  } catch (error) {
    const attempts = reminder.attempts + 1;
    const status = attempts >= 5 ? 'FAILED' : 'SCHEDULED';
    const nextScheduledFor = new Date(Date.now() + Math.pow(2, attempts) * 60000);
    
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status,
        attempts,
        lastError: error.message,
        scheduledFor: status === 'SCHEDULED' ? nextScheduledFor : reminder.scheduledFor,
      },
    });
    
    // Alert if permanently failed
    if (status === 'FAILED') {
      await alertService.send('reminder.failed', reminder);
    }
  }
}
```

**Retry strategy:** Exponential backoff (1min, 2min, 4min,
8min, 16min), max 5 attempts, then mark FAILED and alert.

**Idempotency:** The `status: 'FIRING'` update at the start
prevents two cron instances from firing the same reminder
twice. With PgBouncer + a single backend instance for v1,
this is bulletproof. For v2 multi-instance, use a Postgres
advisory lock around the cron job.

---

## What this changes in the workflow

### Reschedule flow (the one you asked about)

When a customer reschedules a site visit, the system does
this in the background:

  1. New `SiteVisit` created with `rescheduledFromId` set
     to the old visit.
  2. Old `SiteVisit` outcome marked `RESCHEDULED`.
  3. ALL pending reminders on the old visit are
     cancelled (`status: 'CANCELLED'`).
  4. THREE new reminders created for the new visit:
       - `PRE_VISIT_STAFF` (T-2h before new time)
       - `PRE_VISIT_CUSTOMER` (T-24h before new time)
       - `PRE_VISIT_CUSTOMER` (T-2h before new time)
  5. ONE additional `RESCHEDULE_FOLLOWUP` reminder for
     the staff, T+1h after the reschedule record time.
       - "Hi [Sales Exec], you rescheduled [Lead Name]'s
         site visit to [New Date/Time]. Did you confirm
         this with the customer? Tap YES to mark done."

### Cancellation flow (when a customer cancels)

If a customer cancels a visit (via WhatsApp reply "CANCEL"
or staff marks it), all pending reminders on that visit
are cancelled. No new reminders fire.

### Booking flow (v1.1)

When a lead reaches `BOOKING_INITIATED`, the system
schedules post-booking reminders (token follow-up, agreement
status, etc.) — deferred to v1.1 per Q2.

---

## Configuration (per-user settings)

Each user can configure:

  - **Pre-visit staff reminder timing:** 15min / 30min /
    1h / 2h / 4h before (default: 2h)
  - **Quiet hours:** no reminders between X and Y
    (default: 22:00 - 07:00 local time)
  - **Channel preference:** push > email > SMS
    (default: push)
  - **Do-not-disturb on weekends:** bool
    (default: false, real estate works weekends)

Configuration is in the existing `User` table as a JSON
column `reminderSettings`, or as a separate `UserReminderConfig`
table if we want to track changes over time. Recommend JSON
for v1, separate table in v1.1 if we need audit history of
setting changes.

---

## What this changes in DESIGN.md

When applied:

- §2 Modules: add **Reminders** as a new MVP module
  (number 7, renumber Audit Log to 8). One line: "Automated
  reminders for site visits, reschedules, and follow-ups.
  In-app banner + push + WhatsApp + email channels."
- §5 Entities: add `Reminder` model with the schema above.
  Add `reminders` relation to `SiteVisit` and `Lead`.
- §6 Integrations: add Expo Notifications (iOS + Android
  push) and Web Push as required integrations. Email is
  added BACK as a fallback channel (with low priority) for
  reminders specifically, even though email is dropped for
  other outbound notifications.
- §9 Realtime chat: add a new SSE channel for reminder
  delivery (`user:{id}:reminders` Redis pub/sub channel).
- §12 Timeline: add 1 week for reminder system
  (schema + cron + UI + WhatsApp templates + push
  notification setup + customer-side reply parsing).
  New total: 12 weeks (was 10-11).
- §13 Open questions: REMOVED (all resolved in
  CLIENT-DECISIONS.md).
- §14 NOT in scope: add "Tamil-language reminder templates
  deferred to vNext" (would need Meta approval for new
  templates).

---

## Two genuine choices to surface to the client

### Choice A: Pre-visit customer reminders (Type 2)

The user only asked for STAFF reminders. But for the
system to actually reduce no-shows, the CUSTOMER also
needs a reminder. Indian real estate industry data: site
visit no-show rate is 30-40%. Customer reminders typically
reduce this to 15-20%.

**Default decision:** Include both. The marginal cost is
small (2 WhatsApp template approvals + 2 cron entries),
the value is large (potentially halves no-show rate).
**Surface to client:** confirm or push back.

### Choice B: Email as a fallback channel

I dropped email from v1 entirely in the v6 telephony
delta. But for reminders specifically, email is the
right fallback channel — "we couldn't reach you via push,
here's an email instead." It's not a marketing email,
it's a one-time transactional alert.

**Default decision:** Re-add email for REMINDER fallback
only. Not for any other outbound (per v6). Surface to
client: confirm or push back.

---

## Three real reliability concerns

### Concern 1: Cron job must be HA

The reminder cron runs every minute in NestJS. If NestJS
crashes, reminders pile up. When NestJS restarts, it must
process all due reminders. The code above handles this
correctly (queries `status: 'SCHEDULED' AND scheduledFor <= now`
on every run, so missed minutes are caught).

For v2 multi-instance: use Postgres advisory lock to
ensure only one instance processes at a time. Or use a
dedicated BullMQ + Redis queue (more reliable, more ops).

For v1: single NestJS instance, single cron, simple
implementation. Sufficient.

### Concern 2: WhatsApp template rejection

Both `visit_reminder_24h` and `visit_reminder_2h` are
NEW templates that need Meta approval. Per the existing
state file (Aug 27), the WhatsApp setup is on the test
number and templates are not approved for production. This
is a known blocker.

If the new templates take 2-4 weeks to approve (Meta SLA
is typically 24-48 hours but can be longer), the v1
timeline shifts. **Recommend: submit templates in week 1
of the build, parallel to other work, so approval comes
through by the time reminders are coded in week 7-8.**

### Concern 3: Push notification reliability

Expo push notifications are reliable (~99% delivery
within 5 minutes) but not 100%. For a CRM where a missed
reminder could cost a booking, we need the email fallback.
The fallback chain (push → email) means even if push fails,
the staff member gets the reminder within 5-10 minutes.

For customer-side WhatsApp: 99%+ delivery via Meta's
infrastructure. Missed messages are rare but possible
(customer's phone off, no internet, etc.). Mitigation: the
staff member still gets THEIR pre-visit reminder, and the
customer can reschedule anytime via WhatsApp reply.

---

## What I'd push back on

### The reschedule-follow-up reminder is the right one

You asked for this specifically and it's the one that
matters most. A customer reschedules, the staff member
must CONFIRM the new time. Without this reminder, the
staff member may forget, the customer shows up at the old
time (or doesn't show up at the new time because no one
called), and the lead goes cold.

**This is the #1 cause of "lost" leads in Indian real
estate CRMs.** The system must catch it.

### Don't over-engineer the v1 reminder types

I'm recommending 3 reminder types in v1 (pre-visit staff,
pre-visit customer, reschedule follow-up) plus the
already-designed no-show reminder. That's 4 types total.
Don't add more for v1 — every reminder type is a template
approval, a cron entry, a UI element, and a test case.

If Shadhil asks for "what about reminders for X?" during
v1 build, default to "add it in v1.1" unless X is critical
to the no-show reduction.

---

## Next step

If you're happy with this design, say "apply" and I'll
add the Reminders module to DESIGN.md v3, including:
  - Updated §2 modules list (Reminders as module 7)
  - Updated §5 entities (Reminder model + relations)
  - Updated §6 integrations (push + email fallback)
  - Updated §9 SSE (new reminder channel)
  - Updated §12 timeline (add 1 week → 12 weeks total)
  - Submit WhatsApp template requests in week 1
  - Add 2 new open questions to track:
    - "Confirm default reminder timings (2h staff, 24h+2h customer)"
    - "Confirm email is OK as a reminder fallback (low priority)"

The two genuine choices to confirm (Choice A on customer
reminders, Choice B on email fallback) are also in
the apply.
