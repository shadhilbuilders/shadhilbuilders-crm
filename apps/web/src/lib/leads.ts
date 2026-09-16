// Shared lead domain constants + pure helpers (autoplan 2026-09-07, D2/D16).
//
// Single source for the LeadState list the inbox facets + badges render.
// The enum lives in @shadhil/api-types (LeadStateSchema); this mirror is
// pinned by lib/leads.test.ts (drift tripwire) because the enum values
// themselves are NOT exported as a runtime array from the zod schema.
//
// Overdue semantics (IMPLEMENTATION-PLAN Decision 0.2 + §13 KPI #1):
// a lead is overdue when it is still NEW and its time-to-first-touch
// breached the 30-minute target. Applies to NEW only - aging
// NO_SHOW/RESCHEDULED leads are a named non-goal (plan D25, T-AGING).
import type { LeadState } from '@shadhil/api-types';

/** All 12 LeadStates in enum declaration order (api-types/src/enums.ts). */
export const LEAD_STATES: readonly LeadState[] = [
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
  'RESCHEDULED',
  'NO_SHOW',
];

/**
 * Time-to-first-touch SLA target (minutes). IMPLEMENTATION-PLAN §13:
 * median target <30 min in v1. Constant so T-AGING can widen the
 * definition later without touching call sites.
 */
export const OVERDUE_AFTER_MIN = 30;

/** The minimal row shape isOverdue needs (LeadRow + createdAt, D16). */
export type OverdueCheckRow = {
  status?: string | null;
  createdAt?: string | null;
};

/**
 * True when the lead breached first-touch SLA: still NEW and created
 * more than OVERDUE_AFTER_MIN minutes ago. Missing/unknown data is
 * never overdue (fail-closed so a contract change can't fabricate
 * urgency). Exactly-30-min counts as overdue (>= boundary, pinned by
 * lib/leads.test.ts).
 */
export function isOverdue(row: OverdueCheckRow | null | undefined): boolean {
  if (row === null || row === undefined) return false;
  if (row.status !== 'NEW') return false;
  if (typeof row.createdAt !== 'string' || row.createdAt.length === 0) {
    return false;
  }
  const createdMs = Date.parse(row.createdAt);
  if (Number.isNaN(createdMs)) return false;
  return Date.now() - createdMs >= OVERDUE_AFTER_MIN * 60_000;
}

/**
 * Row-tint tiers for the leads table (user request 2026-09-15): a NEW lead's
 * row gets progressively more urgent the longer it has sat untouched.
 *
 *   < 10 min          -> null      (default, white)
 *   10 min – < 20 min -> 'age'     (light yellow)
 *   20 min – < 30 min -> 'warn'    (dark yellow)
 *   >= 30 min         -> 'overdue' (red)
 *
 * Tiers are a clean staircase with no gaps: each boundary belongs to the LATER
 * tier, so a lead is never un-tinted inside a window and 30 min lands on red -
 * the same boundary as OVERDUE_AFTER_MIN, so the row colour and the existing
 * "Overdue" badge can never disagree.
 *
 * NEW-only, by the same rule as isOverdue: once a lead has been picked up the
 * clock stops mattering (plan D25 non-goal - aging CONTACTED/NO_SHOW leads).
 * Unknown data returns null (fail-closed), so a contract change cannot paint a
 * row urgent by accident.
 */
export type LeadAgeTier = 'age' | 'warn' | 'overdue';

export const AGE_WARN_AFTER_MIN = 10;
export const AGE_URGENT_AFTER_MIN = 20;

export function leadAgeTier(
  row: OverdueCheckRow | null | undefined,
  now: number = Date.now(),
): LeadAgeTier | null {
  if (row === null || row === undefined) return null;
  if (row.status !== 'NEW') return null;
  if (typeof row.createdAt !== 'string' || row.createdAt.length === 0) {
    return null;
  }
  const createdMs = Date.parse(row.createdAt);
  if (Number.isNaN(createdMs)) return null;
  const ageMin = (now - createdMs) / 60_000;
  if (ageMin >= OVERDUE_AFTER_MIN) return 'overdue';
  if (ageMin >= AGE_URGENT_AFTER_MIN) return 'warn';
  if (ageMin >= AGE_WARN_AFTER_MIN) return 'age';
  return null;
}

/**
 * Tailwind classes per tier. Kept here (not in the page) so the table and any
 * future surface - a mobile list, a dashboard widget - stay consistent, and so
 * the class values are pinned by a test rather than living only in JSX.
 *
 * `dark:` variants are included because the app ships a theme toggle; a raw
 * `bg-red-50` would glare in dark mode. `/60` opacity keeps the row readable
 * behind the text colours the cells already set.
 */
export const LEAD_AGE_TIER_CLASS: Record<LeadAgeTier, string> = {
  age: 'bg-yellow-50 hover:bg-yellow-100 dark:bg-yellow-950/40 dark:hover:bg-yellow-950/60',
  warn: 'bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/70',
  overdue: 'bg-red-200 hover:bg-red-300 dark:bg-red-950/50 dark:hover:bg-red-950/70',
};