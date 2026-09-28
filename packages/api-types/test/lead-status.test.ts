// Lead status/freshness semantics - the shared contract.
//
// T-STATUS-ONE-TRUTH (2026-09-28). This suite exists because four surfaces used
// to answer "which leads are new / overdue / idle" three different ways:
//
//   admin/overview "Leads not called"   updatedAt <= now() - 1 day (any active state)
//   leads page     "N overdue"          state='NEW' AND createdAt <= now() - 30 min
//   leads page     "N new today"        state='NEW' AND createdAt >= now() - 24h
//   work dashboard "New today"          createdAt >= MIDNIGHT, ALL states
//
// The numbers disagreed, so the operator could not trust either screen. The
// definitions now live here (and in each endpoint's SQL, which imports these
// constants), and these tests pin them - including the boundaries, because a
// 30-minute SLA that is off by one minute is exactly the kind of drift that
// nothing else would catch.
//
// The cross-endpoint agreement itself is pinned in
// apps/backend/src/dashboard/dashboard.status-truth.test.ts, which runs BOTH
// services' real SQL against a real database. This file is the fast contract
// layer; that one is the one that would have caught the original bug.
import { describe, expect, it } from 'vitest';

import {
  isNewToday,
  isOverdue,
  isTerminalLeadState,
  OVERDUE_AFTER_MIN,
  startOfToday,
  TERMINAL_LEAD_STATES,
} from '../src/lead-status';

const MIN = 60_000;

/** A fixed clock so nothing here depends on when the suite runs. */
const NOON = new Date('2026-09-28T12:00:00.000Z');

function iso(msAgo: number, from: Date = NOON): string {
  return new Date(from.getTime() - msAgo).toISOString();
}

describe('OVERDUE_AFTER_MIN', () => {
  it('is the plan\'s 30-minute first-touch target', () => {
    // IMPLEMENTATION-PLAN §13 / Decision 0.2. Pinned so widening the SLA is a
    // deliberate edit with a failing test, not a silent number change.
    expect(OVERDUE_AFTER_MIN).toBe(30);
  });
});

describe('isOverdue - NEW only, 30-minute boundary', () => {
  it('is TRUE for a NEW lead created exactly 30 minutes ago', () => {
    // The boundary belongs to the LATER side: >= 30 min is overdue. Same
    // boundary as the row-tint tier, so colour and badge cannot disagree.
    expect(isOverdue({ status: 'NEW', createdAt: iso(30 * MIN) }, NOON.getTime())).toBe(true);
  });

  it('is FALSE one millisecond inside the SLA', () => {
    expect(
      isOverdue({ status: 'NEW', createdAt: iso(30 * MIN - 1) }, NOON.getTime()),
    ).toBe(false);
  });

  it('is FALSE for a lead that is no longer NEW, however old', () => {
    // The clock stops mattering once a lead is picked up (plan D25 makes aging
    // non-NEW leads an explicit non-goal).
    for (const status of ['CONTACTED', 'VISITED', 'NEGOTIATION', 'WON', 'LOST', 'RNR']) {
      expect(isOverdue({ status, createdAt: iso(90 * 24 * 60 * MIN) }, NOON.getTime())).toBe(
        false,
      );
    }
  });

  it('fails CLOSED on missing or unparseable data', () => {
    // A contract change must not be able to fabricate urgency.
    expect(isOverdue(null, NOON.getTime())).toBe(false);
    expect(isOverdue(undefined, NOON.getTime())).toBe(false);
    expect(isOverdue({}, NOON.getTime())).toBe(false);
    expect(isOverdue({ status: 'NEW' }, NOON.getTime())).toBe(false);
    expect(isOverdue({ status: 'NEW', createdAt: null }, NOON.getTime())).toBe(false);
    expect(isOverdue({ status: 'NEW', createdAt: '' }, NOON.getTime())).toBe(false);
    expect(isOverdue({ status: 'NEW', createdAt: 'not-a-date' }, NOON.getTime())).toBe(false);
  });

  it('accepts a Date as well as an ISO string', () => {
    // The server side hands back real Date objects; the client side gets JSON
    // strings. One predicate has to serve both or the two will diverge again.
    expect(isOverdue({ status: 'NEW', createdAt: new Date(NOON.getTime() - 45 * MIN) }, NOON.getTime())).toBe(true);
    expect(isOverdue({ status: 'NEW', createdAt: new Date(NOON.getTime() - 5 * MIN) }, NOON.getTime())).toBe(false);
  });
});

describe('startOfToday', () => {
  it('is local midnight, preserving the instant otherwise', () => {
    const start = startOfToday(NOON);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    // Same calendar day in LOCAL terms - the only framing under which a
    // "today" counter means anything to the person reading it.
    expect(start.getDate()).toBe(NOON.getDate());
    expect(start.getMonth()).toBe(NOON.getMonth());
    expect(start.getFullYear()).toBe(NOON.getFullYear());
  });

  it('does not mutate the date it is given', () => {
    const input = new Date(NOON);
    startOfToday(input);
    expect(input.getTime()).toBe(NOON.getTime());
  });

  it('is idempotent', () => {
    expect(startOfToday(startOfToday(NOON)).getTime()).toBe(startOfToday(NOON).getTime());
  });
});

describe('isNewToday - midnight AND still NEW', () => {
  it('is TRUE for a NEW lead created after midnight today', () => {
    expect(isNewToday({ status: 'NEW', createdAt: iso(2 * 60 * MIN) }, NOON)).toBe(true);
  });

  it('is TRUE at exactly midnight', () => {
    const start = startOfToday(NOON);
    expect(isNewToday({ status: 'NEW', createdAt: start }, NOON)).toBe(true);
  });

  it('is FALSE for a NEW lead created before midnight, even minutes earlier', () => {
    // THE regression this change fixes. Under the old rolling-24h definition
    // this lead WAS "new today", so the leads page counted it while the
    // dashboard (midnight-based) did not - the same words, two populations.
    const justBeforeMidnight = new Date(startOfToday(NOON).getTime() - 1);
    expect(isNewToday({ status: 'NEW', createdAt: justBeforeMidnight }, NOON)).toBe(false);
  });

  it('is FALSE for a lead created today that is already WON or LOST', () => {
    // The other half of the fix: the dashboard ignored state entirely, so
    // closing a deal INCREASED the "New today" count.
    for (const status of ['WON', 'LOST', 'RNR', 'CONTACTED', 'VISITED']) {
      expect(isNewToday({ status, createdAt: iso(60 * MIN) }, NOON)).toBe(false);
    }
  });

  it('fails CLOSED on missing data', () => {
    expect(isNewToday(null, NOON)).toBe(false);
    expect(isNewToday({ status: 'NEW' }, NOON)).toBe(false);
    expect(isNewToday({ status: 'NEW', createdAt: 'nope' }, NOON)).toBe(false);
  });
});

describe('terminal states', () => {
  it('is exactly the WON/LOST/RNR trio', () => {
    // Mirrors TERMINAL_STATES in leads.state-machine.ts and the SQL
    // `NOT IN ('WON','LOST','RNR')` the exceptions inbox uses.
    expect([...TERMINAL_LEAD_STATES]).toEqual(['WON', 'LOST', 'RNR']);
  });

  it('classifies every LeadState', () => {
    const terminal = ['WON', 'LOST', 'RNR'];
    const active = [
      'NEW',
      'CONTACTED',
      'VISIT_REQUESTED',
      'VISIT_SCHEDULED',
      'VISITED',
      'NEGOTIATION',
      'BOOKING_INITIATED',
      'RESCHEDULED',
      'NO_SHOW',
    ];
    for (const s of terminal) expect(isTerminalLeadState(s)).toBe(true);
    for (const s of active) expect(isTerminalLeadState(s)).toBe(false);
  });

  it('fails CLOSED on unknown input', () => {
    expect(isTerminalLeadState(null)).toBe(false);
    expect(isTerminalLeadState(undefined)).toBe(false);
    expect(isTerminalLeadState('')).toBe(false);
    expect(isTerminalLeadState('SOMETHING_ELSE')).toBe(false);
  });
});
