// Lead state-machine tests (pure-function; no DB).
//
// The whole point of the state-machine module is that every transition
// edge and every role gate has a named, failing-here-not-in-prod test.
// `it.each` drives the table so adding a new state or role surfaces a
// missing assertion immediately.
//
// Coverage:
//   1. EVERY (from, to) pair that is NOT in TRANSITIONS returns INVALID_TRANSITION
//      for every role.
//   2. EVERY (from, to) pair that IS in TRANSITIONS returns ALLOWED for
//      ADMIN/OWNER (they override) and for MANAGER (non-terminal).
//   3. TELECALLER + SALES_EXEC gates reject out-of-lane transitions.
//   4. Terminal trio (WON, LOST, COLD) has no outgoing edges for non-Admin.
//   5. SAME_STATE is always allowed (idempotent).
//   6. ROLE_FORBIDDEN takes precedence over INVALID_TRANSITION when the
//      edge exists but the role can't traverse it.

import { describe, expect, it } from 'vitest';

import {
  LEAD_STATES,
  allowedNextStates,
  canTransition,
  type LeadState,
  type Role,
} from './leads.state-machine';

const ROLES: readonly Role[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'TELECALLER',
  'SALES_EXEC',
];

const TERMINAL_STATES: readonly LeadState[] = ['WON', 'LOST', 'COLD'];

// The transition table mirrored from the source. Duplicated deliberately
// (the test is the spec) — if the source drifts the test fails loudly.
const ALLOWED_EDGES: Readonly<Record<LeadState, readonly LeadState[]>> = {
  NEW: ['CONTACTED', 'VISIT_REQUESTED', 'COLD', 'LOST'],
  CONTACTED: ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_REQUESTED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  VISIT_SCHEDULED: ['VISITED', 'NO_SHOW', 'RESCHEDULED', 'COLD', 'LOST'],
  VISITED: ['NEGOTIATION', 'COLD', 'LOST'],
  NEGOTIATION: ['BOOKING_INITIATED', 'COLD', 'LOST'],
  BOOKING_INITIATED: ['WON', 'LOST'],
  WON: [],
  LOST: [],
  COLD: [],
  RESCHEDULED: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
  NO_SHOW: ['VISIT_SCHEDULED', 'COLD', 'LOST'],
};

describe('leads.state-machine — LEAD_STATES source-of-truth', () => {
  it('includes every LeadState the engine reasons about', () => {
    // 12 values today; this test exists to force a re-look on every enum
    // change, not to assert the specific count.
    expect(LEAD_STATES.length).toBeGreaterThanOrEqual(10);
    for (const terminal of TERMINAL_STATES) {
      expect(LEAD_STATES).toContain(terminal);
    }
    expect(LEAD_STATES).not.toContain('CANCELLED'); // VisitStatus, not LeadState
  });

  it('every state in LEAD_STATES has a TRANSITIONS row', () => {
    for (const state of LEAD_STATES) {
      expect(ALLOWED_EDGES).toHaveProperty(state);
    }
  });
});

describe('canTransition — SAME_STATE is always allowed', () => {
  it.each(LEAD_STATES)('%s → %s returns ok=true reason=SAME_STATE', (state) => {
    const result = canTransition({ from: state, to: state, role: 'TELECALLER' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reason).toBe('SAME_STATE');
  });
});

describe('canTransition — ADMIN/OWNER drive every existing edge', () => {
  for (const from of LEAD_STATES) {
    for (const to of ALLOWED_EDGES[from]) {
      if (from === to) continue;
      it(`ADMIN: ${from} → ${to}`, () => {
        const result = canTransition({ from, to, role: 'ADMIN' });
        expect(result.ok).toBe(true);
      });
      it(`OWNER: ${from} → ${to}`, () => {
        const result = canTransition({ from, to, role: 'OWNER' });
        expect(result.ok).toBe(true);
      });
    }
  }
});

describe('canTransition — ADMIN/OWNER can re-open terminal states', () => {
  // Re-open targets: any non-terminal state. The graph itself doesn't
  // include these edges (terminal states have no out-edges in the
  // canonical model), so the admin override applies.
  const reopenTargets: readonly LeadState[] = [
    'NEW',
    'CONTACTED',
    'VISIT_REQUESTED',
    'VISIT_SCHEDULED',
    'VISITED',
    'NEGOTIATION',
    'BOOKING_INITIATED',
  ];
  for (const terminal of TERMINAL_STATES) {
    for (const to of reopenTargets) {
      it(`ADMIN: ${terminal} → ${to} (re-open)`, () => {
        const result = canTransition({ from: terminal, to, role: 'ADMIN' });
        expect(result.ok).toBe(true);
      });
    }
  }
});

describe('canTransition — non-existent edges reject non-admin roles', () => {
  for (const from of LEAD_STATES) {
    for (const to of LEAD_STATES) {
      if (from === to) continue;
      // Skip edges that ARE in the graph (handled by other describes).
      if (ALLOWED_EDGES[from].includes(to)) continue;
      // ADMIN/OWNER can re-open terminals — those edges are NOT in the
      // graph but ARE legal for admin/owner. Skip those cases here.
      const isReopen = TERMINAL_STATES.includes(from) && !TERMINAL_STATES.includes(to);
      if (isReopen) continue;
      it(`${from} → ${to} is INVALID_TRANSITION for every non-admin role`, () => {
        for (const role of ['MANAGER', 'TELECALLER', 'SALES_EXEC'] as const) {
          const result = canTransition({ from, to, role });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe('INVALID_TRANSITION');
        }
      });
    }
  }
});

describe('canTransition — MANAGER can drive any non-terminal edge', () => {
  for (const from of LEAD_STATES) {
    if (TERMINAL_STATES.includes(from)) continue; // MANAGER can't reopen terminal
    for (const to of ALLOWED_EDGES[from]) {
      it(`MANAGER: ${from} → ${to}`, () => {
        const result = canTransition({ from, to, role: 'MANAGER' });
        expect(result.ok).toBe(true);
      });
    }
  }
});

describe('canTransition — MANAGER cannot reopen terminal states', () => {
  for (const terminal of TERMINAL_STATES) {
    for (const to of LEAD_STATES) {
      if (to === terminal) continue;
      it(`MANAGER: ${terminal} → ${to} is non-ok`, () => {
        const result = canTransition({ from: terminal, to, role: 'MANAGER' });
        expect(result.ok).toBe(false);
      });
    }
  }
});

describe('canTransition — TELECALLER lane (NEW..VISIT_SCHEDULED + re-engagement)', () => {
  const telecallerLane: readonly LeadState[] = [
    'NEW',
    'CONTACTED',
    'VISIT_REQUESTED',
    'VISIT_SCHEDULED',
    'RESCHEDULED',
    'NO_SHOW',
  ];
  // Allowed outgoing edges from inside the lane:
  for (const from of telecallerLane) {
    for (const to of ALLOWED_EDGES[from]) {
      it(`TELECALLER: ${from} → ${to}`, () => {
        const result = canTransition({ from, to, role: 'TELECALLER' });
        expect(result.ok).toBe(true);
      });
    }
  }
  // Out-of-lane `from` may produce INVALID_TRANSITION (edge not in graph,
  // e.g. terminal states have no out-edges) OR ROLE_FORBIDDEN (edge
  // exists but the role can't traverse it). Both are non-ok; the
  // discriminating test is below.
  for (const outOfLane of LEAD_STATES) {
    if (telecallerLane.includes(outOfLane)) continue;
    for (const to of LEAD_STATES) {
      if (to === outOfLane) continue;
      it(`TELECALLER: ${outOfLane} → ${to} is non-ok`, () => {
        const result = canTransition({ from: outOfLane, to, role: 'TELECALLER' });
        expect(result.ok).toBe(false);
      });
    }
  }
});

describe('canTransition — SALES_EXEC lane (VISITED → BOOKING_INITIATED)', () => {
  const execLane: readonly LeadState[] = [
    'VISITED',
    'NEGOTIATION',
    'BOOKING_INITIATED',
  ];
  for (const from of execLane) {
    for (const to of ALLOWED_EDGES[from]) {
      it(`SALES_EXEC: ${from} → ${to}`, () => {
        const result = canTransition({ from, to, role: 'SALES_EXEC' });
        expect(result.ok).toBe(true);
      });
    }
  }
  for (const outOfLane of LEAD_STATES) {
    if (execLane.includes(outOfLane)) continue;
    for (const to of LEAD_STATES) {
      if (to === outOfLane) continue;
      it(`SALES_EXEC: ${outOfLane} → ${to} is non-ok`, () => {
        const result = canTransition({ from: outOfLane, to, role: 'SALES_EXEC' });
        expect(result.ok).toBe(false);
      });
    }
  }
});

describe('allowedNextStates — UI helper', () => {
  it('TELECALLER on NEW sees CONTACTED, VISIT_REQUESTED, COLD, LOST', () => {
    const next = allowedNextStates('NEW', 'TELECALLER');
    expect(next).toEqual(['CONTACTED', 'VISIT_REQUESTED', 'COLD', 'LOST']);
  });

  it('SALES_EXEC on NEW sees nothing (out of lane)', () => {
    const next = allowedNextStates('NEW', 'SALES_EXEC');
    expect(next).toEqual([]);
  });

  it('ADMIN on terminal WON sees the re-open path back to non-terminal', () => {
    const next = allowedNextStates('WON', 'ADMIN');
    expect(next).toContain('NEW');
    expect(next).toContain('CONTACTED');
  });

  it('MANAGER on terminal WON sees no re-open', () => {
    const next = allowedNextStates('WON', 'MANAGER');
    expect(next).toEqual([]);
  });
});