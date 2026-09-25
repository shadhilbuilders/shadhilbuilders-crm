// T-BOOK-LEADSYNC (2026-09-15): booking status ↔ lead state reconciliation.
//
// Pins the user-confirmed business rule and the direction guard that keeps a
// stale re-sync from dragging a closed deal backwards.
import { describe, expect, it } from 'vitest';

import {
  BOOKABLE_LEAD_STATES,
  isBookableLeadState,
  leadStateForBookingStatus,
  leadStateForBookings,
  shouldApplyLeadState,
} from './lead-state-sync';

describe('leadStateForBookingStatus - the confirmed mapping', () => {
  it('HOLD → NEGOTIATION', () => {
    expect(leadStateForBookingStatus('HOLD')).toBe('NEGOTIATION');
  });

  it('TOKEN → BOOKING_INITIATED (DESIGN.md "Token payment received")', () => {
    expect(leadStateForBookingStatus('TOKEN')).toBe('BOOKING_INITIATED');
  });

  it('APPROVED → WON (DESIGN.md "Agreement signed")', () => {
    expect(leadStateForBookingStatus('APPROVED')).toBe('WON');
  });

  it('REJECTED / CANCELLED release the deal back to NEGOTIATION', () => {
    expect(leadStateForBookingStatus('REJECTED')).toBe('NEGOTIATION');
    expect(leadStateForBookingStatus('CANCELLED')).toBe('NEGOTIATION');
  });
});

describe('leadStateForBookings - most advanced active booking wins', () => {
  it('no bookings at all → NEGOTIATION', () => {
    expect(leadStateForBookings([])).toBe('NEGOTIATION');
  });

  it('all terminal bookings → NEGOTIATION (the deal re-enters the pipeline)', () => {
    expect(leadStateForBookings(['CANCELLED', 'REJECTED'])).toBe('NEGOTIATION');
  });

  it('APPROVED beats TOKEN and HOLD', () => {
    expect(leadStateForBookings(['HOLD', 'TOKEN', 'APPROVED'])).toBe('WON');
  });

  it('TOKEN beats HOLD', () => {
    expect(leadStateForBookings(['HOLD', 'TOKEN'])).toBe('BOOKING_INITIATED');
  });

  it('HOLD alone → NEGOTIATION', () => {
    expect(leadStateForBookings(['HOLD'])).toBe('NEGOTIATION');
  });

  it('a terminal booking alongside an active one does not win', () => {
    expect(leadStateForBookings(['CANCELLED', 'APPROVED'])).toBe('WON');
    expect(leadStateForBookings(['CANCELLED', 'HOLD'])).toBe('NEGOTIATION');
  });
});

describe('isBookableLeadState - "lead must be NEGOTIATION or later"', () => {
  it('allows NEGOTIATION / BOOKING_INITIATED / WON', () => {
    for (const s of BOOKABLE_LEAD_STATES) expect(isBookableLeadState(s)).toBe(true);
  });

  it('refuses the pre-negotiation states', () => {
    for (const s of ['NEW', 'CONTACTED', 'VISIT_REQUESTED', 'VISIT_SCHEDULED', 'VISITED'] as const) {
      expect(isBookableLeadState(s)).toBe(false);
    }
  });

  it('refuses dead / off-pipeline leads (reviving is a deliberate act)', () => {
    for (const s of ['RNR', 'LOST', 'RESCHEDULED', 'NO_SHOW'] as const) {
      expect(isBookableLeadState(s)).toBe(false);
    }
  });
});

describe('shouldApplyLeadState - direction guard', () => {
  it('applies a forward move', () => {
    expect(shouldApplyLeadState('NEGOTIATION', 'BOOKING_INITIATED', { allowRegress: false })).toBe(true);
    expect(shouldApplyLeadState('NEGOTIATION', 'WON', { allowRegress: false })).toBe(true);
  });

  it('refuses a backward move unless it is an explicit release', () => {
    expect(shouldApplyLeadState('WON', 'NEGOTIATION', { allowRegress: false })).toBe(false);
    expect(shouldApplyLeadState('WON', 'NEGOTIATION', { allowRegress: true })).toBe(true);
    expect(shouldApplyLeadState('BOOKING_INITIATED', 'NEGOTIATION', { allowRegress: true })).toBe(true);
  });

  it('is a no-op when the state already matches', () => {
    expect(shouldApplyLeadState('WON', 'WON', { allowRegress: true })).toBe(false);
    expect(shouldApplyLeadState('NEGOTIATION', 'NEGOTIATION', { allowRegress: false })).toBe(false);
  });

  it('never drags a RNR/LOST lead on an ordinary sync', () => {
    for (const s of ['RNR', 'LOST'] as const) {
      expect(shouldApplyLeadState(s, 'NEGOTIATION', { allowRegress: false })).toBe(false);
      expect(shouldApplyLeadState(s, 'WON', { allowRegress: false })).toBe(false);
    }
  });

  it('an explicit release may revive a RNR/LOST lead', () => {
    expect(shouldApplyLeadState('LOST', 'NEGOTIATION', { allowRegress: true })).toBe(true);
  });

  // The regression this guard exists for: re-syncing a lead that still carries
  // an older HOLD must not pull a WON deal back to NEGOTIATION.
  it('a stale HOLD cannot regress a WON lead on a non-release sync', () => {
    expect(shouldApplyLeadState('WON', 'NEGOTIATION', { allowRegress: false })).toBe(false);
  });
});
