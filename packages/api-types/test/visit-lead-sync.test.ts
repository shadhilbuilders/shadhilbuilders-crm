import { describe, expect, it } from 'vitest';

import { LeadStateSchema } from '../src/enums';
import {
  OPEN_VISIT_STATUSES,
  isOpenVisitStatus,
  visitFateForLeadState,
} from '../src/visit-lead-sync';

const PAST = new Date('2026-10-01T10:00:00Z');
const FUTURE = new Date('2026-10-20T10:00:00Z');
const NOW = new Date('2026-10-09T10:00:00Z');

describe('open visit definition', () => {
  it('only SCHEDULED is open; RESCHEDULED marks a replaced row', () => {
    expect([...OPEN_VISIT_STATUSES]).toEqual(['SCHEDULED']);
    expect(isOpenVisitStatus('SCHEDULED')).toBe(true);
    expect(isOpenVisitStatus('RESCHEDULED')).toBe(false);
    expect(isOpenVisitStatus('COMPLETED')).toBe(false);
    expect(isOpenVisitStatus(null)).toBe(false);
    expect(isOpenVisitStatus(undefined)).toBe(false);
  });
});

describe('visitFateForLeadState', () => {
  it('VISITED completes the visit regardless of the clock', () => {
    expect(visitFateForLeadState('VISITED', FUTURE, NOW)).toEqual({
      status: 'COMPLETED',
      reason: 'lead-visited',
    });
  });

  it.each(['NEGOTIATION', 'BOOKING_INITIATED', 'WON'] as const)(
    '%s completes a visit whose slot has passed',
    (state) => {
      expect(visitFateForLeadState(state, PAST, NOW)).toEqual({
        status: 'COMPLETED',
        reason: 'lead-advanced',
      });
    },
  );

  it.each(['NEGOTIATION', 'BOOKING_INITIATED', 'WON'] as const)(
    '%s cancels (never completes) a visit still in the future',
    (state) => {
      expect(visitFateForLeadState(state, FUTURE, NOW)).toEqual({
        status: 'CANCELLED',
        reason: 'lead-advanced',
      });
    },
  );

  it('a slot exactly at "now" counts as passed', () => {
    expect(visitFateForLeadState('WON', NOW, NOW)?.status).toBe('COMPLETED');
  });

  it.each(['LOST', 'RNR'] as const)('%s cancels the visit', (state) => {
    expect(visitFateForLeadState(state, FUTURE, NOW)).toEqual({
      status: 'CANCELLED',
      reason: 'lead-terminal',
    });
  });

  it('VISIT_REQUESTED (backed out of booked) cancels the visit', () => {
    expect(visitFateForLeadState('VISIT_REQUESTED', FUTURE, NOW)).toEqual({
      status: 'CANCELLED',
      reason: 'visit-reverted',
    });
  });

  it('RESCHEDULED lead marks its visit RESCHEDULED', () => {
    expect(visitFateForLeadState('RESCHEDULED', FUTURE, NOW)).toEqual({
      status: 'RESCHEDULED',
      reason: 'lead-rescheduled',
    });
  });

  it('NO_SHOW lead marks its visit NO_SHOW', () => {
    expect(visitFateForLeadState('NO_SHOW', PAST, NOW)).toEqual({
      status: 'NO_SHOW',
      reason: 'lead-no-show',
    });
  });

  it.each(['NEW', 'CONTACTED', 'VISIT_SCHEDULED'] as const)(
    '%s leaves the visit alone',
    (state) => {
      expect(visitFateForLeadState(state, FUTURE, NOW)).toBeNull();
    },
  );

  it('has an explicit decision for every LeadState (no state falls through unnoticed)', () => {
    for (const state of LeadStateSchema.options) {
      expect(() => visitFateForLeadState(state, PAST, NOW)).not.toThrow();
    }
  });

  it('returns null for an unknown state instead of guessing', () => {
    expect(visitFateForLeadState('MADE_UP', PAST, NOW)).toBeNull();
    expect(visitFateForLeadState(null, PAST, NOW)).toBeNull();
  });
});
