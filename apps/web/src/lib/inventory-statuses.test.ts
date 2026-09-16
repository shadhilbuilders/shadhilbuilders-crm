// @vitest-environment node
// T-INV-SYNC (2026-09-15): the status values staff may hand-set.
//
// Unit.status is derived from the booking lifecycle (DB trigger
// unit_status_sync_booking). HOLD/TOKEN only ever exist because a booking says
// so, which is why the inventory edit dialog offers just the two off-pipeline
// marks and the server DTO (UpdateUnitStatusSchema) rejects the rest.
//
// Mirrors packages/api-types/src/inventory.ts UpdateUnitStatusSchema - if
// these two ever drift, the UI offers a status the API answers 400 for.
import { describe, expect, it } from 'vitest';

import { UpdateUnitStatusSchema } from '@shadhil/api-types';
import {
  INVENTORY_MANUAL_STATUSES,
  INVENTORY_STATUSES,
  DERIVED_UNIT_STATUSES,
  isDerivedUnitStatus,
} from '@/lib/labels';

describe('INVENTORY_MANUAL_STATUSES (T-INV-SYNC)', () => {
  it('offers exactly the off-pipeline marks', () => {
    expect([...INVENTORY_MANUAL_STATUSES]).toEqual(['AVAILABLE', 'SOLD']);
  });

  it('is a strict subset of the full unit-status enum', () => {
    for (const status of INVENTORY_MANUAL_STATUSES) {
      expect(INVENTORY_STATUSES).toContain(status);
    }
    expect(INVENTORY_MANUAL_STATUSES.length).toBeLessThan(INVENTORY_STATUSES.length);
  });

  it('omits HOLD and TOKEN - those come from bookings', () => {
    expect(INVENTORY_MANUAL_STATUSES).not.toContain('HOLD');
    expect(INVENTORY_MANUAL_STATUSES).not.toContain('TOKEN');
  });

  it('matches the server DTO option set exactly', () => {
    const serverOptions = UpdateUnitStatusSchema.options;
    expect([...serverOptions].sort()).toEqual([...INVENTORY_MANUAL_STATUSES].sort());
  });
});

// T-INV-SYNC follow-up: the set the dialog must render read-only and never
// submit. Kept in step with the enum so a future status can't silently become
// uneditable (the original bug: the dialog submitted HOLD, the DTO rejected it,
// and every save on a held unit 400'd).
describe('DERIVED_UNIT_STATUSES', () => {
  it('is exactly HOLD and TOKEN', () => {
    expect([...DERIVED_UNIT_STATUSES]).toEqual(['HOLD', 'TOKEN']);
  });

  it('is disjoint from the manually-settable set', () => {
    for (const status of DERIVED_UNIT_STATUSES) {
      expect(INVENTORY_MANUAL_STATUSES).not.toContain(status);
    }
  });

  it('covers every unit status that is neither manual nor booking-terminal', () => {
    // AVAILABLE/SOLD are manual; HOLD/TOKEN are derived. Nothing else exists -
    // if the enum grows, this fails and the new value has to be classified.
    const classified = [...INVENTORY_MANUAL_STATUSES, ...DERIVED_UNIT_STATUSES].sort();
    expect(classified).toEqual([...INVENTORY_STATUSES].sort());
  });

  it('isDerivedUnitStatus answers correctly', () => {
    expect(isDerivedUnitStatus('HOLD')).toBe(true);
    expect(isDerivedUnitStatus('TOKEN')).toBe(true);
    expect(isDerivedUnitStatus('AVAILABLE')).toBe(false);
    expect(isDerivedUnitStatus('SOLD')).toBe(false);
    expect(isDerivedUnitStatus('')).toBe(false);
  });
});
