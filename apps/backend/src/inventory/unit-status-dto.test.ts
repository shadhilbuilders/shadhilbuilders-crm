// T-INV-SYNC (2026-09-15) - the DTO contract that stops the inventory grid
// from drifting away from the bookings list.
//
// Unit.status is derived from the booking lifecycle: the DB trigger
// unit_status_sync_booking (migration 20260915060000_unit_status_sync)
// recomputes it on every booking write. So a staff member must not be able to
// hand-set HOLD or TOKEN - those only exist because a booking says so - and
// the PATCH DTO accepts only the off-pipeline marks.
//
// Before this narrowing, the inventory unit edit form offered the full
// AVAILABLE|HOLD|TOKEN|SOLD list, and a hand-set value stuck forever because
// nothing recomputed it. Together with the RLS-silenced sync write in
// bookings.service.ts (Unit UPDATE was ADMIN-only, so MANAGER/SALES_EXEC/
// TELECALLER writes matched zero rows without error) that is exactly how the
// two pages ended up disagreeing.
import { describe, expect, it } from 'vitest';

import { CreateUnitDtoSchema, UpdateUnitDtoSchema } from '@shadhil/api-types';

describe('UpdateUnitDtoSchema - manual unit status override (T-INV-SYNC)', () => {
  it('accepts the off-pipeline marks', () => {
    expect(UpdateUnitDtoSchema.safeParse({ status: 'AVAILABLE' }).success).toBe(true);
    expect(UpdateUnitDtoSchema.safeParse({ status: 'SOLD' }).success).toBe(true);
  });

  it('rejects HOLD - it only comes from a live booking', () => {
    const result = UpdateUnitDtoSchema.safeParse({ status: 'HOLD' });
    expect(result.success).toBe(false);
  });

  it('rejects TOKEN - it only comes from a live booking', () => {
    const result = UpdateUnitDtoSchema.safeParse({ status: 'TOKEN' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown status values', () => {
    expect(UpdateUnitDtoSchema.safeParse({ status: 'BOOKED' }).success).toBe(false);
    expect(UpdateUnitDtoSchema.safeParse({ status: 'available' }).success).toBe(false);
  });

  it('still allows the non-status fields on their own', () => {
    const result = UpdateUnitDtoSchema.safeParse({
      unitNumber: 'A-102',
      bhk: 3,
      facing: null,
      sqft: null,
      pricePerSqft: 4000,
    });
    expect(result.success).toBe(true);
  });

  it('allows an empty payload (partial update)', () => {
    expect(UpdateUnitDtoSchema.safeParse({}).success).toBe(true);
  });
});

// T-INV-SYNC follow-up: POST was the last way to put a unit into a
// booking-owned status by hand. A unit created as HOLD has no booking, and the
// trigger only fires on Booking writes - so it stayed HOLD forever AND could
// never accept a booking (the bookable-unit guard rejects a non-AVAILABLE unit).
// A dead unit, creatable through the API. The create DTO now mirrors the PATCH
// one; the service refuses it too.
describe('CreateUnitDtoSchema - a new unit cannot be born booking-owned', () => {
  const base = {
    phaseId: 'clh3v8q2x0000qzrmn831i7rn',
    unitNumber: 'A-101',
    bhk: 2,
    buildupSqft: 1000,
    pricePerSqft: 5000,
  };

  it('accepts AVAILABLE (and the default, no status)', () => {
    expect(CreateUnitDtoSchema.safeParse({ ...base, status: 'AVAILABLE' }).success).toBe(true);
    expect(CreateUnitDtoSchema.safeParse(base).success).toBe(true);
  });

  it('accepts SOLD - an admin may register a unit sold outside the pipeline', () => {
    expect(CreateUnitDtoSchema.safeParse({ ...base, status: 'SOLD' }).success).toBe(true);
  });

  it('rejects HOLD - there is no booking to justify it', () => {
    expect(CreateUnitDtoSchema.safeParse({ ...base, status: 'HOLD' }).success).toBe(false);
  });

  it('rejects TOKEN - there is no booking to justify it', () => {
    expect(CreateUnitDtoSchema.safeParse({ ...base, status: 'TOKEN' }).success).toBe(false);
  });

  it('agrees with the PATCH DTO on the allowed status set', () => {
    const allowed = ['AVAILABLE', 'SOLD', 'HOLD', 'TOKEN'];
    for (const status of allowed) {
      const created = CreateUnitDtoSchema.safeParse({ ...base, status });
      const patched = UpdateUnitDtoSchema.safeParse({ status });
      expect(created.success, `create vs patch disagree on ${status}`).toBe(patched.success);
    }
  });
});
