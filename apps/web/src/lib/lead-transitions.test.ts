import { describe, expect, it } from 'vitest';

import {
  allowedTransitionsFor,
  reopenTargetsFor,
  splitTransitions,
  TRANSITIONS,
} from './lead-transitions';

describe('splitTransitions', () => {
  it('never offers VISIT_SCHEDULED as a manual move (only Schedule visit books)', () => {
    for (const [status, outgoing] of Object.entries(TRANSITIONS)) {
      const { forward, back } = splitTransitions(status, outgoing);
      expect([...forward, ...back], status).not.toContain('VISIT_SCHEDULED');
    }
  });

  it('never lists a back target among the forward buttons', () => {
    const { forward, back } = splitTransitions('CONTACTED', TRANSITIONS.CONTACTED ?? []);
    expect(back).toEqual(['NEW']);
    expect(forward).not.toContain('NEW');
    expect(forward).toContain('VISIT_REQUESTED');
  });

  it('Visit booked backs out to Visit requested', () => {
    const { forward, back } = splitTransitions('VISIT_SCHEDULED', TRANSITIONS.VISIT_SCHEDULED ?? []);
    expect(back).toEqual(['VISIT_REQUESTED']);
    expect(forward).not.toContain('VISIT_REQUESTED');
  });

  it('Visit requested backs out to Contacted', () => {
    expect(splitTransitions('VISIT_REQUESTED', TRANSITIONS.VISIT_REQUESTED ?? []).back).toEqual([
      'CONTACTED',
    ]);
  });

  it('VISITED/NEGOTIATION keep "request again" off the forward buttons (Visit panel owns it)', () => {
    for (const status of ['VISITED', 'NEGOTIATION']) {
      const { forward } = splitTransitions(status, TRANSITIONS[status] ?? []);
      expect(forward).not.toContain('VISIT_REQUESTED');
    }
    expect(splitTransitions('NEGOTIATION', TRANSITIONS.NEGOTIATION ?? []).back).toEqual(['VISITED']);
    expect(splitTransitions('VISITED', TRANSITIONS.VISITED ?? []).back).toEqual(['VISIT_REQUESTED']);
  });

  it('every state except NEW and the terminal trio offers a Move back step', () => {
    const noBack = new Set(['NEW', 'WON', 'LOST', 'RNR']);
    for (const [status, outgoing] of Object.entries(TRANSITIONS)) {
      const { back } = splitTransitions(status, outgoing);
      if (noBack.has(status)) {
        expect(back, status).toEqual([]);
      } else {
        expect(back, status).toHaveLength(1);
      }
    }
  });
});

describe('allowedTransitionsFor - repeat visit', () => {
  it('exec may request again from VISITED and schedule from VISIT_REQUESTED', () => {
    expect(allowedTransitionsFor('VISITED', 'SALES_EXEC')).toContain('VISIT_REQUESTED');
    expect(allowedTransitionsFor('VISIT_REQUESTED', 'SALES_EXEC')).toEqual(['VISIT_SCHEDULED']);
  });

  it('telecaller cannot act on VISITED', () => {
    expect(allowedTransitionsFor('VISITED', 'TELECALLER')).toEqual([]);
  });
});

describe('reopenTargetsFor - admin Reopen on closed leads', () => {
  it('offers reopen targets to ADMIN/OWNER on WON, LOST and RNR', () => {
    for (const status of ['WON', 'LOST', 'RNR']) {
      for (const role of ['ADMIN', 'OWNER']) {
        const targets = reopenTargetsFor(status, role);
        expect(targets.length, `${role}/${status}`).toBeGreaterThan(0);
        expect(targets).not.toContain('VISIT_SCHEDULED');
      }
    }
  });

  it('offers nothing to other roles or on open leads', () => {
    for (const role of ['MANAGER', 'TELECALLER', 'SALES_EXEC', undefined]) {
      expect(reopenTargetsFor('LOST', role)).toEqual([]);
    }
    expect(reopenTargetsFor('NEGOTIATION', 'ADMIN')).toEqual([]);
  });

  it('every reopen target is a legal admin reopen on the backend (non-terminal)', () => {
    for (const t of reopenTargetsFor('LOST', 'ADMIN')) {
      expect(['WON', 'LOST', 'RNR']).not.toContain(t);
    }
  });
});
