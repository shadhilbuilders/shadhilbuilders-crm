// ────────────────────────────────────────────────────────────────────────────
// Lead state + freshness semantics - THE single source of truth.
// ────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS (2026-09-28).
//
// Four surfaces each computed "which leads are new / overdue / idle" their own
// way, and the numbers disagreed:
//
//   admin/overview "Leads not called"  state NOT IN WON/LOST/RNR
//                                      AND updatedAt <= now() - 1 day
//   leads page     "N overdue"         state='NEW' AND createdAt <= now() - 30 min
//   leads page     "N new today"       state='NEW' AND createdAt >= now() - 24h
//   work dashboard "New today"         createdAt >= midnight, ALL states
//
// The work dashboard's label said "New today", its sub-text said "created in the
// last 24h", and its query counted since MIDNIGHT including leads already WON or
// LOST that day - three different meanings on one card. A KPI that disagrees with
// the list it summarises is not a cosmetic problem: the operator stops trusting
// both numbers.
//
// The lesson generalises the two fixes that came before this one in
// `visits`/`auto-assign`: when two surfaces answer the same question, they must
// call the same function. Duplicating a definition - even a correct one - is the
// defect. So the definitions AND the predicates that apply them live here, and
// the endpoints/UI import them rather than restating the rule.
//
// This module is pure and framework-free (no React, no Nest, no Prisma client)
// so it is callable from a Postgres WHERE clause, a Nest service and a Next
// component alike, and testable in milliseconds.

import type { LeadState } from './enums';

// ────────────────────────────────────────────────────────────────────────────
// State groups
// ────────────────────────────────────────────────────────────────────────────

/**
 * Terminal lead states - the archive, not forgotten work.
 *
 * A lead here is finished: WON closed the deal, LOST went cold, RNR ("ring no
 * response") is parked after max attempts. None of them belong in a "needs
 * attention" count, because no action is available on them
 * (`leads.state-machine.ts` gives them no outgoing edges except an Admin
 * override).
 *
 * This mirrors `TERMINAL_STATES` in the backend state machine and the SQL
 * `NOT IN ('WON','LOST','RNR')` used by the auto-assign pool and the exceptions
 * inbox. Those call sites predate this constant; new code must use it.
 */
export const TERMINAL_LEAD_STATES: readonly LeadState[] = ['WON', 'LOST', 'RNR'];

/** True when the lead is finished and should be excluded from active counts. */
export function isTerminalLeadState(state: string | null | undefined): boolean {
  return (
    typeof state === 'string' &&
    (TERMINAL_LEAD_STATES as readonly string[]).includes(state)
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Freshness windows
// ────────────────────────────────────────────────────────────────────────────

/**
 * Time-to-first-touch SLA, in minutes. IMPLEMENTATION-PLAN §13 / Decision 0.2:
 * a NEW lead should be contacted within 30 minutes, and the *median* target is
 * `<30 min` in v1.
 *
 * Applies to NEW ONLY, by design (plan D25 names aging NO_SHOW/RESCHEDULED leads
 * as an explicit non-goal). Once a lead has been picked up, first-touch has
 * happened and this clock stops being the right question.
 */
export const OVERDUE_AFTER_MIN = 30;

/**
 * "New today" window: since LOCAL MIDNIGHT, not a rolling 24 hours.
 *
 * The user's call (2026-09-28), and the reason it is a calendar window rather
 * than a duration: the card answers "what came in today" - a batch an operator
 * reconciles at the end of a shift. A rolling window would drop yesterday
 * afternoon's leads off the number partway through the morning, so the same
 * screen would disagree with itself across a coffee break.
 *
 * `startOfToday` is the ONE implementation of "midnight". Call it; do not
 * reconstruct it with `toISOString().slice(0,10)` or a SQL `date_trunc` literal,
 * because those diverge the moment the database session timezone and the Node
 * process timezone stop agreeing.
 */
export function startOfToday(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * "New today" is also STATE-SCOPED: a lead created today that is already WON or
 * LOST is not new, it is done. Without this the card counts closed deals and can
 * never agree with the leads page, whose own tooltip promises "created today
 * that are still in the NEW state".
 */
export const NEW_TODAY_STATE: LeadState = 'NEW';

// ────────────────────────────────────────────────────────────────────────────
// Predicates
//
// Each returns a tri-state-safe boolean: missing/unknown data is NEVER counted
// as urgent. That is deliberate fail-closed behaviour - a contract change must
// not be able to fabricate urgency by handing us an undefined date.
// ────────────────────────────────────────────────────────────────────────────

/** The minimal row shape the predicates need. */
export type LeadFreshnessRow = {
  status?: string | null;
  createdAt?: string | Date | null;
};

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True when the lead breached first-touch SLA: still NEW and created more than
 * OVERDUE_AFTER_MIN minutes ago. Exactly-30-minutes counts as overdue (>= at the
 * boundary), pinned by test.
 */
export function isOverdue(
  row: LeadFreshnessRow | null | undefined,
  now: number = Date.now(),
): boolean {
  if (row === null || row === undefined) return false;
  if (row.status !== NEW_TODAY_STATE) return false;
  const createdMs = toMs(row.createdAt);
  if (createdMs === null) return false;
  return now - createdMs >= OVERDUE_AFTER_MIN * 60_000;
}

/**
 * True when the lead was created since local midnight AND is still NEW - the
 * exact definition behind every "new today" number in the UI.
 */
export function isNewToday(
  row: LeadFreshnessRow | null | undefined,
  now: Date = new Date(),
): boolean {
  if (row === null || row === undefined) return false;
  if (row.status !== NEW_TODAY_STATE) return false;
  const createdMs = toMs(row.createdAt);
  if (createdMs === null) return false;
  return createdMs >= startOfToday(now).getTime();
}
