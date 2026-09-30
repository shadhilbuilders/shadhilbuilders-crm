// Queue row-action matrix tests (T-DASH-QUEUE, 2026-09-16).
//
// This is the most security-relevant logic on the dashboard: it decides which
// state transitions each role is even OFFERED. It is pure on purpose, so the
// whole matrix can be pinned here in milliseconds with no rendering.
//
// The most important case in this file is the TELECALLER-NEVER-VISITED test.
// A telecaller must not be offered a path to VISITED: only the assigned
// SALES_EXEC (or manager/admin) records a visit. If that test ever fails, the
// dashboard is inviting users to make a call the server will refuse.
import { describe, expect, it } from 'vitest';

import { canScheduleVisits } from '@/lib/session';
import { LEAD_STATES_AWAITING_A_VISIT, SCHEDULABLE_LEAD_STATES } from '@shadhil/api-types';
import {
  queueActionsFor,
  QUEUE_STATES_BY_ROLE,
  TERMINAL_LEAD_STATES,
  type QueueRole,
} from './queue-actions';

const ROLES = ['TELECALLER', 'SALES_EXEC', 'MANAGER', 'ADMIN', 'OWNER'] as const;

describe('queueActionsFor - the telecaller lane', () => {
  it('offers both common outcomes on a brand-new lead, most likely first', () => {
    // "Called" and "Wants a visit" are the two answers a telecaller actually
    // gives. Order matters: the row renders the first two inline.
    const actions = queueActionsFor({ role: 'TELECALLER', status: 'NEW' });
    expect(actions.map((a) => a.label)).toEqual(['Called', 'Wants a visit']);
    expect(actions.map((a) => a.dataQa)).toEqual([
      'queue-move-contacted',
      'queue-move-visit_requested',
    ]);
  });

  it('NEVER offers a route to VISITED, for any role', () => {
    // The single most important assertion in this file. Recording a visit is
    // the assigned exec's action, not a queue button.
    for (const role of ROLES) {
      for (const status of ['NEW', 'CONTACTED', 'VISIT_SCHEDULED', 'VISITED', 'NO_SHOW']) {
        const targets = queueActionsFor({ role, status })
          .filter((a) => a.kind === 'transition')
          .map((a) => (a.kind === 'transition' ? a.to : ''));
        expect(targets).not.toContain('VISITED');
      }
    }
  });

  it('gives the telecaller No-show as their only outcome on a scheduled visit', () => {
    const actions = queueActionsFor({ role: 'TELECALLER', status: 'VISIT_SCHEDULED' });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'transition', to: 'NO_SHOW' });
  });

  it('offers Schedule visit on every state that can accept one', () => {
    for (const status of ['VISIT_REQUESTED', 'RESCHEDULED', 'NO_SHOW']) {
      const actions = queueActionsFor({ role: 'TELECALLER', status });
      expect(actions).toEqual([
        expect.objectContaining({ kind: 'scheduleVisit', label: 'Schedule visit' }),
      ]);
    }
  });

  it('uses plain words, never raw enum names', () => {
    for (const status of ['NEW', 'CONTACTED', 'VISIT_SCHEDULED']) {
      for (const action of queueActionsFor({ role: 'TELECALLER', status })) {
        expect(action.label).not.toMatch(/^[A-Z_]+$/);
      }
    }
  });
});

/**
 * T-VISIT-NO-SHOW-SCHEDULING (2026-09-30) - the drift tripwire.
 *
 * The bug this pins: the queue offered "Schedule visit" on a NO_SHOW lead while
 * `VisitsService.create` answered `400 Lead state NO_SHOW cannot accept a visit`.
 * The two lists were written separately and nothing compared them, so the only
 * place the disagreement could surface was the operator's screen.
 *
 * The test reads the SERVER's constant (not a copied literal) and asserts that
 * every state it permits is offered a schedule action, and that no state it
 * forbids is. Widen the server list without the matrix (or the reverse) and this
 * goes red before a user ever sees the button.
 */
describe('queueActionsFor - agrees with the server on which leads accept a visit', () => {
  const ALL_STATUSES = [
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

  it('offers Schedule visit for exactly LEAD_STATES_AWAITING_A_VISIT', () => {
    // The queue and the endpoint are deliberately NOT identical, and the one
    // difference is named here so it cannot widen by accident:
    //
    //   VISIT_SCHEDULED - the server accepts a create from it (the calendar
    //   books a second, parallel visit that way), but the queue row offers its
    //   ONE action instead: "No show". A lead with a live appointment is not
    //   waiting to be booked.
    //
    // Everything else must match, in BOTH directions: a state the server accepts
    // must be offered (that is the original bug - NO_SHOW was not), and a state
    // it refuses must never be offered (a button the API 400s).
    const queueExpected = LEAD_STATES_AWAITING_A_VISIT;
    for (const status of ALL_STATUSES) {
      const offered = queueActionsFor({ role: 'TELECALLER', status }).some(
        (a) => a.kind === 'scheduleVisit',
      );
      expect(
        offered,
        `TELECALLER on ${status}: queue offers=${offered}, queue should offer=${queueExpected.includes(status as never)}`,
      ).toBe(queueExpected.includes(status as never));
    }
    // The exception itself, asserted so it reads as intentional, and the
    // relationship between the two lists pinned: awaiting-a-visit IS the server
    // list minus VISIT_SCHEDULED, nothing else.
    expect(SCHEDULABLE_LEAD_STATES).toContain('VISIT_SCHEDULED');
    expect(queueExpected).not.toContain('VISIT_SCHEDULED');
    expect([...LEAD_STATES_AWAITING_A_VISIT]).toEqual(
      SCHEDULABLE_LEAD_STATES.filter((s) => s !== 'VISIT_SCHEDULED'),
    );
  });

  it('does not offer Schedule visit on VISIT_SCHEDULED (the lead already has a live visit)', () => {
    // The lead-side No-show button is this state's only queue action; booking a
    // second, parallel visit is the reschedule/calendar flow, not a queue button.
    const actions = queueActionsFor({ role: 'TELECALLER', status: 'VISIT_SCHEDULED' });
    expect(actions.every((a) => a.kind !== 'scheduleVisit')).toBe(true);
  });
});

describe('queueActionsFor - who may schedule', () => {
  it('lets the telecaller, manager and admin schedule on a wanted visit', () => {
    for (const role of ['TELECALLER', 'MANAGER', 'ADMIN', 'OWNER'] as const) {
      expect(queueActionsFor({ role, status: 'VISIT_REQUESTED' })).toHaveLength(1);
    }
  });

  it('does NOT offer scheduling to a sales exec', () => {
    // The exec conducts visits; the telecaller books them. Offering a button
    // the server refuses is worse than omitting it.
    expect(queueActionsFor({ role: 'SALES_EXEC', status: 'VISIT_REQUESTED' })).toEqual([]);
  });

  it('agrees with canScheduleVisits in @/lib/session, so the two cannot drift', () => {
    // This module re-implements the gate locally to stay dependency-free. That
    // is only safe while the two agree, so they are compared directly here.
    for (const role of ROLES) {
      const offered = queueActionsFor({ role, status: 'VISIT_REQUESTED' }).length > 0;
      expect(offered).toBe(canScheduleVisits(role));
    }
  });
});

describe('queueActionsFor - the exec lane', () => {
  it('walks an exec lead forward: visited -> negotiating -> booking', () => {
    expect(queueActionsFor({ role: 'SALES_EXEC', status: 'VISITED' })[0]).toMatchObject({
      to: 'NEGOTIATION',
    });
    expect(queueActionsFor({ role: 'SALES_EXEC', status: 'NEGOTIATION' })[0]).toMatchObject({
      to: 'BOOKING_INITIATED',
    });
  });

  it('refuses to let an exec close a booking', () => {
    expect(queueActionsFor({ role: 'SALES_EXEC', status: 'BOOKING_INITIATED' })).toEqual([]);
  });
});

describe('queueActionsFor - closing and terminal states', () => {
  it('lets a manager close a booking, but not a telecaller or exec', () => {
    expect(queueActionsFor({ role: 'MANAGER', status: 'BOOKING_INITIATED' })[0]).toMatchObject({
      to: 'WON',
    });
    expect(queueActionsFor({ role: 'ADMIN', status: 'BOOKING_INITIATED' })[0]).toMatchObject({
      to: 'WON',
    });
    expect(queueActionsFor({ role: 'TELECALLER', status: 'BOOKING_INITIATED' })).toEqual([]);
    expect(queueActionsFor({ role: 'SALES_EXEC', status: 'BOOKING_INITIATED' })).toEqual([]);
  });

  it('returns nothing for terminal states (WON/LOST/RNR)', () => {
    for (const status of ['WON', 'LOST', 'RNR']) {
      for (const role of ROLES) {
        expect(queueActionsFor({ role, status })).toEqual([]);
      }
    }
  });

  it('returns nothing for an unknown or missing status rather than guessing', () => {
    expect(queueActionsFor({ role: 'TELECALLER', status: '' })).toEqual([]);
    expect(queueActionsFor({ role: 'TELECALLER', status: 'SOMETHING_NEW' })).toEqual([]);
  });
});

describe('QUEUE_STATES_BY_ROLE', () => {
  it('gives the telecaller their whole lane and nothing past it', () => {
    const states = QUEUE_STATES_BY_ROLE.TELECALLER;
    expect(states).toContain('NEW');
    expect(states).toContain('NO_SHOW');
    // The telecaller's queue must not pull in the exec lane or terminal states.
    expect(states).not.toContain('VISITED');
    expect(states).not.toContain('NEGOTIATION');
    expect(states).not.toContain('WON');
    expect(states).not.toContain('LOST');
  });

  it('gives the exec the post-visit lane only', () => {
    // BOOKING_INITIATED removed: an exec has no action there (closing to WON is
    // manager-only), so it was a row with no button in their queue. The manager
    // lane owns it now.
    expect(QUEUE_STATES_BY_ROLE.SALES_EXEC).toEqual(['VISITED', 'NEGOTIATION']);
  });

  // ── T-DASH-QUEUE-SCOPE (2026-09-16, owner decision) ────────────────────────
  // "A queue shows WORK, not the whole pipeline."
  describe('lane scoping', () => {
    it('gives the manager a lane instead of the whole pipeline', () => {
      // Regression guard: the manager lane used to be NO filter at all, so their
      // queue was every lead in scope - the majority VISITED, which a manager
      // cannot move.
      const states = QUEUE_STATES_BY_ROLE.MANAGER;
      expect(states.length).toBeGreaterThan(0);
      expect(states).not.toContain('VISITED');
      expect(states).not.toContain('NEGOTIATION');
    });

    it('keeps BOOKING_INITIATED in the manager lane - only a manager can close it', () => {
      // THE TRAP this pins: dropping BOOKING_INITIATED as "not actionable for me"
      // would make a closing deal unreachable from the surface its closer uses.
      // BOOKING_INITIATED -> WON is offered to MANAGER/ADMIN/OWNER and nobody else.
      expect(QUEUE_STATES_BY_ROLE.MANAGER).toContain('BOOKING_INITIATED');
      expect(queueActionsFor({ role: 'MANAGER', status: 'BOOKING_INITIATED' })).toEqual([
        expect.objectContaining({ to: 'WON' }),
      ]);
      for (const role of ['TELECALLER', 'SALES_EXEC'] as const) {
        expect(QUEUE_STATES_BY_ROLE[role]).not.toContain('BOOKING_INITIATED');
      }
    });

    it('excludes terminal states from EVERY lane', () => {
      // WON / LOST / RNR are records, not work: no role has an action for them.
      for (const states of Object.values(QUEUE_STATES_BY_ROLE)) {
        for (const terminal of TERMINAL_LEAD_STATES) {
          expect(states).not.toContain(terminal);
        }
      }
    });

    it('offers at least one action for every state in EVERY lane', () => {
      // The whole point of the scoping: nothing in a queue is un-actionable.
      // EXCEPT the states whose only control is "Schedule visit", which returns a
      // scheduleVisit spec rather than a transition - still a real action.
      for (const [role, states] of Object.entries(QUEUE_STATES_BY_ROLE)) {
        for (const status of states) {
          const actions = queueActionsFor({ role: role as QueueRole, status });
          expect(actions.length, `${role} lane: ${status} has no action`).toBeGreaterThan(0);
        }
      }
    });

    it('covers every terminal state that the state machine declares terminal', () => {
      // Drift tripwire against leads.state-machine.ts: if a new terminal state
      // ships, it must be added here or it will silently appear in queues.
      expect([...TERMINAL_LEAD_STATES].sort()).toEqual(['LOST', 'RNR', 'WON']);
    });
  });

  it('offers an action for every telecaller-lane state that should have one', () => {
    // Drift tripwire: a state added to the lane without an action (or an action
    // for a state not in the lane) would leave a dead or unreachable row.
    const noActionExpected = ['VISIT_REQUESTED', 'RESCHEDULED', 'NO_SHOW'];
    for (const status of QUEUE_STATES_BY_ROLE.TELECALLER) {
      const actions = queueActionsFor({ role: 'TELECALLER', status });
      expect(actions.length > 0).toBe(true);
      if (noActionExpected.includes(status)) {
        expect(actions[0]).toMatchObject({ kind: 'scheduleVisit' });
      } else {
        expect(actions[0]).toMatchObject({ kind: 'transition' });
      }
    }
  });
});
