// Friendly-label mapping for every engineering enum that ever reaches the
// user. The server keeps the canonical enum string (database column, API
// payload, RLS predicate); the UI never displays the raw value — it looks
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
// Plan §9.1 enum source of truth — kept verbatim below. When the Prisma
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
//   │ COLD                │ Cold               │
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

// ---------------------------------------------------------------------------
// Source-of-truth lists (the test asserts `labelFor(enum, x)` is defined
// for every x in these lists — see `labels.test.ts`).
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
  'COLD',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Visit-outcome values per the Prisma `Visit.outcome` enum. */
export const VISIT_OUTCOMES = [
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
  'RESCHEDULED',
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

/** Inventory-unit values per the Prisma `InventoryUnit.status` enum. */
export const INVENTORY_STATUSES = [
  'AVAILABLE',
  'HOLD',
  'TOKEN',
  'SOLD',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Talked',
  VISIT_REQUESTED: 'Visit requested',
  VISIT_SCHEDULED: 'Visit booked',
  VISITED: 'Visited',
  NEGOTIATION: 'Negotiating',
  BOOKING_INITIATED: 'Booking in progress',
  WON: 'Won 🎉',
  LOST: 'Lost',
  COLD: 'Cold',
};

const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
  COMPLETED: 'Done',
  NO_SHOW: "Didn't show up",
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Postponed',
};

const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  AVAILABLE: 'Available',
  HOLD: 'On hold',
  TOKEN: 'Token received',
  SOLD: 'Sold',
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
  kind: 'lead',
  value: string,
): string;
export function labelFor(
  kind: 'visit',
  value: string,
): string;
export function labelFor(
  kind: 'inventory',
  value: string,
): string;
export function labelFor(
  kind: 'lead' | 'visit' | 'inventory',
  value: string,
): string {
  if (kind === 'lead') {
    const mapped = (LEAD_STATUS_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else if (kind === 'visit') {
    const mapped = (VISIT_OUTCOME_LABELS as Record<string, string>)[value];
    if (mapped !== undefined) return mapped;
  } else {
    const mapped = (INVENTORY_STATUS_LABELS as Record<string, string>)[value];
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
