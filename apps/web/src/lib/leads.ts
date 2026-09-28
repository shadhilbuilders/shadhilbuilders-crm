// Shared lead domain constants + pure helpers (autoplan 2026-09-07, D2/D16).
//
// Single source for the LeadState list the inbox facets + badges render.
// The enum lives in @shadhil/api-types (LeadStateSchema); this mirror is
// pinned by lib/leads.test.ts (drift tripwire) because the enum values
// themselves are NOT exported as a runtime array from the zod schema.
//
// T-STATUS-ONE-TRUTH (2026-09-28): the overdue/refresh SEMANTICS moved to
// `@shadhil/api-types` (packages/api-types/src/lead-status.ts) and are
// re-exported below. They used to be defined here AND restated in
// `dashboard.service.ts` as inline SQL (`interval '30 minutes'`,
// `interval '24 hours'`, `date_trunc('day', now())`) - so the card and the list
// it summarised could count different populations while both claiming to be
// "overdue"/"new today". The definitions now live once and both layers import
// them; this file keeps the React-free re-export surface its callers already
// use, so nothing else has to change.
import type { LeadState } from '@shadhil/api-types';
// Imported (for local use by `leadAgeTier` below) AND re-exported, so every
// existing caller of `@/lib/leads` keeps working against the ONE definition.
import {
  OVERDUE_AFTER_MIN,
  isOverdue,
  isNewToday,
  startOfToday,
  TERMINAL_LEAD_STATES,
  isTerminalLeadState,
  type LeadFreshnessRow,
} from '@shadhil/api-types';
export {
  OVERDUE_AFTER_MIN,
  isOverdue,
  isNewToday,
  startOfToday,
  TERMINAL_LEAD_STATES,
  isTerminalLeadState,
  type LeadFreshnessRow,
};

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
  'RNR',
  'RESCHEDULED',
  'NO_SHOW',
];

/** Alias kept for the existing call sites (`isOverdue(row)` shape). */
export type OverdueCheckRow = { status?: string | null; createdAt?: string | null };

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