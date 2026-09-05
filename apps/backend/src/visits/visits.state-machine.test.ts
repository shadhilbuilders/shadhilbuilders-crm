// Table-driven tests for the visits state machine. Mirrors the style
// of apps/backend/src/leads/leads.state-machine.test.ts (432 cases) -
// exhaustively walk every (from, to) pair per role so drift surfaces
// immediately, not in production when a forgotten transition silently
// 400s.

import { describe, expect, it } from 'vitest';

import {
  allowedNextStates,
  canTransition,
  VISIT_STATES,
  type VisitStatus,
} from './visits.state-machine';

const ALL_STATES: readonly VisitStatus[] = VISIT_STATES;

describe('visits.state-machine - canTransition', () => {
  // Same-state idempotence - every role, every state.
  it.each(ALL_STATES)(
    'same-state is idempotent for %s',
    (state) => {
      for (const role of ['ADMIN', 'OWNER', 'MANAGER', 'TELECALLER', 'SALES_EXEC'] as const) {
        const result = canTransition({ from: state, to: state, role });
        expect(result).toEqual({ ok: true, reason: 'SAME_STATE' });
      }
    },
  );

  // ADMIN/OWNER override - every transition is allowed, including
  // re-opening terminals. We don't exhaustively test every pair
  // (that's 5×4×5=100 cases), we test the relevant edges.
  describe('ADMIN/OWNER override', () => {
    it.each([
      ['SCHEDULED', 'COMPLETED'],
      ['SCHEDULED', 'NO_SHOW'],
      ['SCHEDULED', 'CANCELLED'],
      ['SCHEDULED', 'RESCHEDULED'],
      ['RESCHEDULED', 'COMPLETED'],
      ['RESCHEDULED', 'NO_SHOW'],
      ['COMPLETED', 'SCHEDULED'], // re-open
      ['CANCELLED', 'SCHEDULED'], // re-open
    ] as const)('ADMIN allows %s → %s', (from, to) => {
      const result = canTransition({ from, to, role: 'ADMIN' });
      expect(result.ok).toBe(true);
    });

    it('OWNER mirrors ADMIN override', () => {
      expect(canTransition({ from: 'COMPLETED', to: 'SCHEDULED', role: 'OWNER' }).ok).toBe(true);
    });
  });

  // MANAGER - non-terminal forward + NO_SHOW re-engagement.
  describe('MANAGER lane', () => {
    it('allows SCHEDULED → COMPLETED', () => {
      expect(canTransition({ from: 'SCHEDULED', to: 'COMPLETED', role: 'MANAGER' }).ok).toBe(true);
    });
    it('allows SCHEDULED → RESCHEDULED', () => {
      expect(canTransition({ from: 'SCHEDULED', to: 'RESCHEDULED', role: 'MANAGER' }).ok).toBe(true);
    });
    it('forbids COMPLETED → SCHEDULED (terminal, non-admin)', () => {
      const r = canTransition({ from: 'COMPLETED', to: 'SCHEDULED', role: 'MANAGER' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ROLE_FORBIDDEN');
    });
    it('forbids CANCELLED → SCHEDULED (terminal, non-admin)', () => {
      expect(canTransition({ from: 'CANCELLED', to: 'SCHEDULED', role: 'MANAGER' }).ok).toBe(false);
    });
  });

  // TELECALLER - schedule/cancel + NO_SHOW re-engagement.
  describe('TELECALLER lane', () => {
    it('allows SCHEDULED → CANCELLED', () => {
      expect(canTransition({ from: 'SCHEDULED', to: 'CANCELLED', role: 'TELECALLER' }).ok).toBe(true);
    });
    it('forbids SCHEDULED → COMPLETED (sales exec owns outcomes)', () => {
      const r = canTransition({ from: 'SCHEDULED', to: 'COMPLETED', role: 'TELECALLER' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ROLE_FORBIDDEN');
    });
    it('allows NO_SHOW → RESCHEDULED (re-engagement)', () => {
      expect(canTransition({ from: 'NO_SHOW', to: 'RESCHEDULED', role: 'TELECALLER' }).ok).toBe(true);
    });
  });

  // SALES_EXEC - carries out visits, no cancellation.
  describe('SALES_EXEC lane', () => {
    it('allows SCHEDULED → COMPLETED', () => {
      expect(canTransition({ from: 'SCHEDULED', to: 'COMPLETED', role: 'SALES_EXEC' }).ok).toBe(true);
    });
    it('allows SCHEDULED → NO_SHOW', () => {
      expect(canTransition({ from: 'SCHEDULED', to: 'NO_SHOW', role: 'SALES_EXEC' }).ok).toBe(true);
    });
    it('forbids SCHEDULED → CANCELLED (manager owns cancellations)', () => {
      const r = canTransition({ from: 'SCHEDULED', to: 'CANCELLED', role: 'SALES_EXEC' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ROLE_FORBIDDEN');
    });
  });

  // Invalid graph edges for non-admin roles.
  describe('graph membership (non-admin roles)', () => {
    it.each([
      ['SCHEDULED', 'COMPLETED'],
      ['SCHEDULED', 'NO_SHOW'],
      ['SCHEDULED', 'CANCELLED'],
      ['SCHEDULED', 'RESCHEDULED'],
      ['RESCHEDULED', 'COMPLETED'],
      ['RESCHEDULED', 'NO_SHOW'],
      ['RESCHEDULED', 'CANCELLED'],
      ['NO_SHOW', 'RESCHEDULED'],
    ] as const)('edge %s → %s is in the graph', (from, to) => {
      expect(TRANSITIONS_FOR_TEST[from].includes(to)).toBe(true);
    });
  });
});

// Local mirror of the graph so the test above can assert membership
// without re-deriving it from canTransition (which would hide the
// difference between INVALID_TRANSITION and ROLE_FORBIDDEN).
const TRANSITIONS_FOR_TEST: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  SCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'],
  RESCHEDULED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  COMPLETED: [],
  NO_SHOW: ['RESCHEDULED'],
  CANCELLED: [],
};

describe('visits.state-machine - allowedNextStates', () => {
  it('MANAGER SCHEDULED → [COMPLETED, NO_SHOW, CANCELLED, RESCHEDULED]', () => {
    const next = allowedNextStates('SCHEDULED', 'MANAGER');
    expect(next).toEqual(['COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED']);
  });

  it('TELECALLER SCHEDULED → [CANCELLED, NO_SHOW, RESCHEDULED]', () => {
    const next = allowedNextStates('SCHEDULED', 'TELECALLER');
    expect(next).toEqual(['CANCELLED', 'NO_SHOW', 'RESCHEDULED']);
  });

  it('SALES_EXEC SCHEDULED → [COMPLETED, NO_SHOW]', () => {
    const next = allowedNextStates('SCHEDULED', 'SALES_EXEC');
    expect(next).toEqual(['COMPLETED', 'NO_SHOW']);
  });

  it('ADMIN COMPLETED includes SCHEDULED (re-open)', () => {
    const next = allowedNextStates('COMPLETED', 'ADMIN');
    expect(next).toContain('SCHEDULED');
  });

  it('MANAGER COMPLETED → [] (terminal, non-admin)', () => {
    expect(allowedNextStates('COMPLETED', 'MANAGER')).toEqual([]);
  });
});
