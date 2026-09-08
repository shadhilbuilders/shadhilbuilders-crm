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