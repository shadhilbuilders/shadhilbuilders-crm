// @vitest-environment node
// T-BOOK-ROLES (2026-09-15): the booking role gates, pinned to DESIGN.md §4.
//
// Two defects shipped before this because the gate and the UI were written
// independently:
//   1. The service rejected OWNER from approving (literal `!== 'ADMIN'` check)
//      while the UI showed OWNER the Approve button.
//   2. TELECALLER could initiate a booking - no role gate on create/→TOKEN.
//
// These tests pin the UI helper so it stays in step with the service gate.
// The mirror is the point: if the two drift, a user gets a 403 on a button the
// app offered them.
import { describe, expect, it } from 'vitest';

import {
  canApproveBookings,
  canInitiateBookings,
} from '@/lib/session';

// DESIGN.md §4 columns: SuperAdmin | Admin | Manager | Telecaller | SalesExec
//   Initiate booking: ✅ ✅ ✅(in team) ❌ ✅(post-visit)
//   Approve booking:  ✅ ✅ ✅(in team) ❌ ❌
const ALL_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC'] as const;

describe('canInitiateBookings (DESIGN.md §4 "Initiate booking")', () => {
  it('allows SuperAdmin/Admin/Manager/SalesExec', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC'] as const) {
      expect(canInitiateBookings(role)).toBe(true);
    }
  });

  it('refuses TELECALLER', () => {
    expect(canInitiateBookings('TELECALLER')).toBe(false);
  });

  it('refuses an absent/unknown role', () => {
    expect(canInitiateBookings(undefined)).toBe(false);
  });

  it('covers every role in the enum (no accidental default-allow)', () => {
    const allowed = ALL_ROLES.filter((r) => canInitiateBookings(r));
    expect([...allowed].sort()).toEqual(['ADMIN', 'MANAGER', 'OWNER', 'SALES_EXEC']);
  });
});

describe('canApproveBookings (DESIGN.md §4 "Approve booking")', () => {
  it('allows SuperAdmin/Admin/Manager', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) {
      expect(canApproveBookings(role)).toBe(true);
    }
  });

  it('includes OWNER - the service used to 400 an owner who pressed Approve', () => {
    expect(canApproveBookings('OWNER')).toBe(true);
  });

  it('refuses both staff roles', () => {
    for (const role of ['TELECALLER', 'SALES_EXEC'] as const) {
      expect(canApproveBookings(role)).toBe(false);
    }
  });

  it('is a strict subset of who may initiate', () => {
    for (const role of ALL_ROLES) {
      if (canApproveBookings(role)) {
        expect(canInitiateBookings(role)).toBe(true);
      }
    }
    // SALES_EXEC initiates but does not approve.
    expect(canInitiateBookings('SALES_EXEC')).toBe(true);
    expect(canApproveBookings('SALES_EXEC')).toBe(false);
  });
});
