// Friendly-label mapping for every engineering enum that ever reaches the
// user. The server keeps the canonical enum string (database column, API
// payload, RLS predicate); the UI never displays the raw value - it looks
// it up here, falling back to a humanized form of the key.
//
// Why a separate file (D2 + Eng-review Section 1 P1):
//   - Sales staff (non-technical) read this UI. "VISIT_REQUESTED" →
//     "Visit requested" is the same concept to engineering, but the
//     uppercase snake case is hostile to a first-time visitor.
//   - The enum source of truth lives in the Prisma schema
//     (`packages/database/prisma/schema.prisma`). If a new enum value is
//     added there, the test in `labels.test.ts` will assert the new value
//     has a label entry before a PR can merge.
//   - One file, one source. `LeadStatusBadge`, the visit-outcome buttons,
//     and the inventory picker all read from here, so a label rename
//     touches exactly one site.
//
// Plan §9.1 enum source of truth - kept verbatim below. When the Prisma
// schema gains or removes a value, this table and the test must follow.
//
//   ┌─────────────────────┬────────────────────┐
//   │ Engineering (enum)  │ Friendly UI        │
//   ├─────────────────────┼────────────────────┤
//   │ NEW                 │ New                │
//   │ CONTACTED           │ Talked             │
//   │ VISIT_REQUESTED     │ Visit requested    │
//   │ VISIT_SCHEDULED     │ Visit booked       │
//   │ VISITED             │ Visited            │
//   │ NEGOTIATION         │ Negotiating        │
//   │ BOOKING_INITIATED   │ Booking in progress│
//   │ WON                 │ Won 🎉             │
//   │ LOST                │ Lost               │
//   │ RNR                 │ Unresponsive       │
//   │ NO_SHOW             │ Didn't show up     │
//   │ RESCHEDULED         │ Postponed          │
//   │ CANCELLED           │ Cancelled          │
//   │ COMPLETED           │ Done               │
//   │ AVAILABLE           │ Available          │
//   │ HOLD                │ On hold            │
//   │ TOKEN               │ Token received     │
//   │ SOLD                │ Sold               │
//   └─────────────────────┴────────────────────┘
//
// Emoji policy: 🎉 is the ONLY emoji (per §9.1). It's a deliberate
// celebration signal for the WON transition; everything else is plain
// text so the UI reads as a work tool, not a chat app.

import { LEAD_STATE_LABELS } from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// Source-of-truth lists (the test asserts `labelFor(enum, x)` is defined
// for every x in these lists - see `labels.test.ts`).
// ---------------------------------------------------------------------------

/** Lead-status values per the Prisma `Lead.status` enum. */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'WON',
  'LOST',
  'RNR',
  'RESCHEDULED',
  'NO_SHOW',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Visit-outcome values per the Prisma `Visit.outcome` enum.
 *
 * NOTE (2026-09-29): `SiteVisit.STATUS` is a DIFFERENT enum from `outcome` and
 * has five values - it adds `SCHEDULED`, which has no outcome equivalent. Both
 * were previously routed through `labelFor('visit', ...)`, whose map covers only
 * these four, so a SCHEDULED visit fell through to `humanize()` and rendered
 * "Scheduled" by accident rather than by contract.
 *
 * The visits page now shows the LEAD's pipeline state (via `labelFor('lead', ...)`)
 * as its status word, so both pages use one vocabulary, and the visit's own
 * status is only ever displayed through `VISIT_STATUS_LABELS` below.
 */
export const VISIT_OUTCOMES = [
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
  'RESCHEDULED',
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

/**
 * The five `SiteVisit.status` values (packages/api-types/src/enums.ts
 * `VisitStatusSchema`). Kept as its own list because `VISIT_OUTCOMES` above is
 * NOT the same set - it is missing SCHEDULED, which is why every status check
 * written against `VISIT_OUTCOMES` was silently unable to name an upcoming visit.
 */
export const VISIT_STATUSES = [
  'SCHEDULED',
  'RESCHEDULED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/**
 * A visit whose work is still ahead of it: the statuses the visits page shows by
 * default. COMPLETED/NO_SHOW/CANCELLED are history - they are reachable through
 * the page's "Show past" toggle, not the default view (owner direction,
 * 2026-09-29: "In visits page only show scheduled visit and rescheduled visit
 * and upcoming visit data").
 */
export const UPCOMING_VISIT_STATUSES = ['SCHEDULED'] as const;


/** Inventory-unit values per the Prisma `InventoryUnit.status` enum. */
export const INVENTORY_STATUSES = [
  'AVAILABLE',
  'HOLD',
  'TOKEN',
  'SOLD',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

/**
 * T-INV-SYNC (2026-09-15): the subset of unit statuses a staff member may set
 * BY HAND. Unit.status is derived from the booking lifecycle (a booking
 * trigger recomputes it; see migration 20260915060000_unit_status_sync), so
 * HOLD/TOKEN only ever come from a booking. AVAILABLE and SOLD are the two
 * off-pipeline marks an admin legitimately chooses, and the server rejects any
 * value that contradicts the unit's live bookings with a 409.
 * Mirrors UpdateUnitStatusSchema in @shadhil/api-types.
 */
export const INVENTORY_MANUAL_STATUSES = ['AVAILABLE', 'SOLD'] as const;
export type InventoryManualStatus = (typeof INVENTORY_MANUAL_STATUSES)[number];

/**
 * T-INV-SYNC follow-up (2026-09-15): unit statuses that a BOOKING produces and
 * that no form may submit.
 *
 * These are not "hidden" options - they are not editable values at all. The
 * edit dialog used to seed its status picker from the unit's own current
 * status and always submit it, so editing a held unit sent `status: 'HOLD'`,
 * which `UpdateUnitStatusSchema` (AVAILABLE|SOLD only) rejects with a 400.
 * Every save on a held or token-paid unit failed, including pure price/BHK
 * edits. Callers must render these read-only and omit them from the payload.
 */
export const DERIVED_UNIT_STATUSES = ['HOLD', 'TOKEN'] as const;

/** True when the unit's status is owned by its booking, not by a form. */
export function isDerivedUnitStatus(status: string): boolean {
  return (DERIVED_UNIT_STATUSES as readonly string[]).includes(status);
}

/**
 * Booking-lifecycle values per the Prisma `Booking.status` enum.
 * Added 2026-09-04 alongside the booking page wire-up. The friendly
 * labels match §0.11 plan copy.
 */
export const BOOKING_STATUSES = [
  'HOLD',
  'TOKEN',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Lead-source values as stored in the DB (free-form uppercase strings,
 * not a Prisma enum). The Source column renders these via `labelFor('source', ...)`
 * so staff see "Magicbricks" not "MAGICBRICKS". Added 2026-09-08.
 */
export const LEAD_SOURCES = [
  '99ACRES',
  'HOUSING',
  'LANDING',
  'MAGICBRICKS',
  'META_AD',
  'OTHER',
  'REFERRAL',
  'WALK_IN',
  'WEBSITE',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * Activity-timeline entry types (Prisma `Activity.type` enum). The lead
 * detail timeline renders these via `labelFor('activity', ...)` so staff see
 * "Call" not "CALL". Added 2026-09-08 alongside the lead detail timeline.
 */
export const ACTIVITY_TYPES = [
  'CALL',
  'NOTE',
  'STATUS_CHANGE',
  'VISIT',
  'EMAIL',
  'ASSIGNMENT',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

// Lead-state labels live in @shadhil/api-types (shared with the backend
// Activity timeline writer).
const LEAD_STATUS_LABELS: Record<LeadStatus, string> = LEAD_STATE_LABELS;

const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
  COMPLETED: 'Done',
  NO_SHOW: "Didn't show up",
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Postponed',
};

/**
 * The five `SiteVisit.status` values. `labelFor('visit', ...)` resolves through
 * here first, falling back to the outcome map (they overlap on four values and
 * the outcomes' friendlier wording is the established one).
 *
 * SCHEDULED is the entry that did not exist anywhere before 2026-09-29: the
 * visits page's most common state had no label, so it silently rendered through
 * `humanize()`. Pinned by labels.test.ts.
 */
const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  SCHEDULED: 'Visit booked',
  RESCHEDULED: 'Postponed',
  COMPLETED: 'Done',
  NO_SHOW: "Didn't show up",
  CANCELLED: 'Cancelled',
};

const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  AVAILABLE: 'Available',
  HOLD: 'On hold',
  TOKEN: 'Token received',
  SOLD: 'Sold',
};

const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  HOLD: 'On hold',
  TOKEN: 'Token received',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  '99ACRES': '99acres',
  HOUSING: 'Housing.com',
  LANDING: 'Landing site',
  MAGICBRICKS: 'Magicbricks',
  META_AD: 'Meta ads',
  OTHER: 'Other',
  REFERRAL: 'Referral',
  WALK_IN: 'Walk-in',
  WEBSITE: 'Website',
};

const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  CALL: 'Call',
  NOTE: 'Note',
  STATUS_CHANGE: 'Status change',
  VISIT: 'Visit',
  EMAIL: 'Email',
  ASSIGNMENT: 'Assignment',
};

/**
 * Staff-role values per the Prisma `User.role` enum (OWNER/ADMIN/MANAGER/
 * SALES_EXEC/TELECALLER). The users page renders these via
 * `labelFor('role', ...)` so staff see "Sales executive" not "SALES_EXEC".
 * Added 2026-09-09 alongside the users-page DataTable rebuild.
 */
export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'SALES_EXEC',
  'TELECALLER',
] as const;
export type RoleLabel = (typeof ROLES)[number];

const ROLE_LABELS: Record<RoleLabel, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  SALES_EXEC: 'Sales Executive',
  TELECALLER: 'Telecaller',
};

/**
 * Feedback triage-status values per the Prisma `Feedback.status` enum
 * (NEW/REVIEWED/ARCHIVED). The admin feedback page renders these via
 * `labelFor('feedback', ...)`. Added 2026-09-11 alongside the feedback
 * admin page + public submit API.
 */
export const FEEDBACK_STATUSES = ['NEW', 'REVIEWED', 'ARCHIVED'] as const;
export type FeedbackStatusLabel = (typeof FEEDBACK_STATUSES)[number];

const FEEDBACK_STATUS_LABELS: Record<FeedbackStatusLabel, string> = {
  NEW: 'New',
  REVIEWED: 'Reviewed',
  ARCHIVED: 'Archived',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a friendly label for a known enum value. Falls back to a
 * humanized form of the raw key so that an unmapped enum still renders
 * readably (e.g. `labelFor('lead', 'PARTIAL_DEPOSIT')` → `'Partial deposit'`).
 *
 * The fallback exists so a freshly-added Prisma enum value never produces
 * a broken UI; the test in `labels.test.ts` then surfaces the gap as a
 * failing assertion so the label table gets updated before merge.
 */
export function labelFor(
  kind: 'lead' | 'visit' | 'inventory' | 'booking' | 'source' | 'activity' | 'role' | 'feedback',
  value: string,
): string {
  if (kind === 'lead') {
    const mapped = (LEAD_STATUS_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'visit') {
    // Status first (it is the superset), then the outcome map. Both are needed:
    // the UI passes a visit STATUS when showing where a visit stands, and an
    // OUTCOME when showing what was recorded on site.
    const asStatus = (VISIT_STATUS_LABELS as Record<string, string>)[value];
    if (asStatus !== undefined) return asStatus;
    const mapped = (VISIT_OUTCOME_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'inventory') {
    const mapped = (INVENTORY_STATUS_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'source') {
    const mapped = (LEAD_SOURCE_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'activity') {
    const mapped = (ACTIVITY_TYPE_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'role') {
    const mapped = (ROLE_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'feedback') {
    const mapped = (FEEDBACK_STATUS_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else {
    const mapped = (BOOKING_STATUS_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  }
  return humanize(value);
}

/**
 * Title-case humanization for an unmapped enum key. `NO_SHOW` → `No show`.
 * This is a safety net, not the primary path: the test enforces a
 * per-value entry for every enum in the source-of-truth lists.
 */
export function humanize(raw: string): string {
  if (raw.length === 0) return raw;
  const lower = raw.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
