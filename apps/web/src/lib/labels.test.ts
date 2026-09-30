// @vitest-environment node
// Source-of-truth assertion for `lib/labels.ts`.
//
// Per Eng-review Section 1 P1: every Prisma enum value listed in
// `LEAD_STATUSES` / `VISIT_OUTCOMES` / `INVENTORY_STATUSES` /
// `BOOKING_STATUSES` MUST have a matching entry in the corresponding
// labels table. This test fails the build the moment a new enum
// value lands in the Prisma schema but the UI table is forgotten.
import { describe, expect, it } from 'vitest';

import {
  humanize,
  labelFor,
  LEAD_STATUSES,
  INVENTORY_STATUSES,
  VISIT_OUTCOMES,
  VISIT_STATUSES,
  BOOKING_STATUSES,
  LEAD_SOURCES,
  ACTIVITY_TYPES,
  ROLES,
  FEEDBACK_STATUSES,
  type LeadStatus,
  type VisitOutcome,
  type VisitStatus,
  type InventoryStatus,
  type BookingStatus,
  type LeadSource,
  type ActivityType,
  type RoleLabel,
  type FeedbackStatusLabel,
} from '@/lib/labels';

describe('lib/labels', () => {
  describe('LEAD_STATUSES - every enum value has a friendly label', () => {
    it.each(LEAD_STATUSES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('lead', value);
      expect(label.length).toBeGreaterThan(0);
      // Reject the raw enum leaking to the UI (the original bug T11 fixes).
      expect(label).not.toBe(value);
      // Reject ALL_CAPS or SHOUTY_SNAKE (the original bug).
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit §9.1 mappings', () => {
      const expectations: Record<LeadStatus, string> = {
        NEW: 'New',
        CONTACTED: 'Talked',
        VISIT_REQUESTED: 'Visit requested',
        VISIT_SCHEDULED: 'Visit booked',
        VISITED: 'Visited',
        NEGOTIATION: 'Negotiating',
        BOOKING_INITIATED: 'Booking in progress',
        WON: 'Won 🎉',
        LOST: 'Lost',
        RNR: 'Unresponsive',
        // autoplan 2026-09-07: full 12-state coverage (visit-outcome
        // states are also lead states; same friendly labels).
        RESCHEDULED: 'Postponed',
        NO_SHOW: "Didn't show up",
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('lead', enumValue)).toBe(expected);
      }
    });
  });

  describe('VISIT_OUTCOMES - every enum value has a friendly label', () => {
    it.each(VISIT_OUTCOMES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('visit', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit §9.1 mappings', () => {
      const expectations: Record<VisitOutcome, string> = {
        COMPLETED: 'Done',
        NO_SHOW: "Didn't show up",
        CANCELLED: 'Cancelled',
        RESCHEDULED: 'Postponed',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('visit', enumValue)).toBe(expected);
      }
    });

    // THE GAP THIS CLOSES (2026-09-29). The two tests above iterate
    // VISIT_OUTCOMES, which holds FOUR values. `SiteVisit.status` has FIVE - it
    // also has SCHEDULED. Because the status enum was never iterated, SCHEDULED
    // had no entry in any label map and fell through to `humanize()`, rendering
    // "Scheduled" (non-empty, non-raw, not SCREAMING) and passing every assertion
    // above. The visits page's most common state was therefore labelled by
    // accident. These assertions make the status enum the tested set.
    it.each(VISIT_STATUSES)('status %s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('visit', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('is EXPLICIT about the status values, so none can regress', () => {
      // The real guarantee is this table: every status has a CURATED word, and
      // the words match what the UI shows. (Asserting `!== humanize(value)`
      // instead would be wrong - humanize('CANCELLED') is legitimately
      // "Cancelled", so a curated label may coincide with the fallback.)
      const expectations: Record<VisitStatus, string> = {
        SCHEDULED: 'Visit booked',
        RESCHEDULED: 'Postponed',
        COMPLETED: 'Done',
        NO_SHOW: "Didn't show up",
        CANCELLED: 'Cancelled',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('visit', enumValue)).toBe(expected);
      }
    });

    it('names SCHEDULED deliberately, not via the humanize() fallback', () => {
      // SCHEDULED is the value that was missing. It must be the curated wording,
      // and specifically NOT the title-cased enum ("Scheduled") that the fallback
      // produced - that is the exact regression this pins.
      expect(labelFor('visit', 'SCHEDULED')).toBe('Visit booked');
      expect(labelFor('visit', 'SCHEDULED')).not.toBe(humanize('SCHEDULED'));
    });

    it('names a visit status and its outcome the same way where they overlap', () => {
      // One vocabulary across surfaces: the visits dialog reads a visit STATUS,
      // the lead page reads the LEAD state, and for the states they share the
      // words must match so the same event reads the same on both pages.
      // NO_SHOW / RESCHEDULED appear in BOTH enums.
      expect(labelFor('visit', 'NO_SHOW')).toBe(labelFor('lead', 'NO_SHOW'));
      expect(labelFor('visit', 'RESCHEDULED')).toBe(labelFor('lead', 'RESCHEDULED'));
      // COMPLETED maps to the lead's VISITED - the handoff. The two use different
      // enum names for one business event, so they are asserted as a pair rather
      // than for equality.
      expect(labelFor('visit', 'COMPLETED')).toBe('Done');
      expect(labelFor('lead', 'VISITED')).toBe('Visited');
    });
  });

  describe('INVENTORY_STATUSES - every enum value has a friendly label', () => {
    it.each(INVENTORY_STATUSES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('inventory', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit §9.1 mappings', () => {
      const expectations: Record<InventoryStatus, string> = {
        AVAILABLE: 'Available',
        HOLD: 'On hold',
        TOKEN: 'Token received',
        SOLD: 'Sold',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('inventory', enumValue)).toBe(expected);
      }
    });
  });

  describe('BOOKING_STATUSES - every enum value has a friendly label', () => {
    it.each(BOOKING_STATUSES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('booking', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit §0.11 mappings', () => {
      const expectations: Record<BookingStatus, string> = {
        HOLD: 'On hold',
        TOKEN: 'Token received',
        APPROVED: 'Approved',
        REJECTED: 'Rejected',
        CANCELLED: 'Cancelled',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('booking', enumValue)).toBe(expected);
      }
    });
  });

  describe('LEAD_SOURCES - every source value has a friendly label', () => {
    it.each(LEAD_SOURCES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('source', value);
      expect(label.length).toBeGreaterThan(0);
      // Reject the raw enum leaking to the UI (the original bug T11 fixes).
      expect(label).not.toBe(value);
      // Reject ALL_CAPS or SHOUTY_SNAKE (the original bug).
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit source mappings', () => {
      const expectations: Record<LeadSource, string> = {
        '99ACRES': '99acres',
        HOUSING: 'Housing.com',
        LANDING: 'Landing site',
        MAGICBRICKS: 'Magicbricks',
        META_AD: 'Meta ads',
        OTHER: 'Other',
        REFERRAL: 'Referral',
        WALK_IN: 'Walk-in',
        WEBSITE: 'Website',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('source', enumValue)).toBe(expected);
      }
    });
  });

  describe('ACTIVITY_TYPES - every activity type has a friendly label', () => {
    it.each(ACTIVITY_TYPES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('activity', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit activity mappings', () => {
      const expectations: Record<ActivityType, string> = {
        CALL: 'Call',
        NOTE: 'Note',
        STATUS_CHANGE: 'Status change',
        VISIT: 'Visit',
        EMAIL: 'Email',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('activity', enumValue)).toBe(expected);
      }
    });
  });

  describe('ROLES - every role value has a friendly label', () => {
    it.each(ROLES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('role', value);
      expect(label.length).toBeGreaterThan(0);
      // Reject the raw enum leaking to the UI.
      expect(label).not.toBe(value);
      // Reject ALL_CAPS or SHOUTY_SNAKE.
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit role mappings', () => {
      const expectations: Record<RoleLabel, string> = {
        OWNER: 'Owner',
        ADMIN: 'Admin',
        MANAGER: 'Manager',
        SALES_EXEC: 'Sales Executive',
        TELECALLER: 'Telecaller',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('role', enumValue)).toBe(expected);
      }
    });
  });

  describe('FEEDBACK_STATUSES - every feedback status has a friendly label', () => {
    it.each(FEEDBACK_STATUSES)('%s renders a non-empty, non-raw label', (value) => {
      const label = labelFor('feedback', value);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    });

    it('contains the explicit feedback mappings', () => {
      const expectations: Record<FeedbackStatusLabel, string> = {
        NEW: 'New',
        REVIEWED: 'Reviewed',
        ARCHIVED: 'Archived',
      };
      for (const [enumValue, expected] of Object.entries(expectations)) {
        expect(labelFor('feedback', enumValue)).toBe(expected);
      }
    });
  });

  describe('fallback behavior', () => {
    it('humanizes unknown lead enums instead of leaking the raw value', () => {
      // The fallback exists so a new Prisma enum value never breaks the
      // UI; the test suite still flags the gap on the next run.
      expect(labelFor('lead', 'PARTIAL_DEPOSIT')).toBe('Partial deposit');
      expect(labelFor('visit', 'LEFT_VOICEMAIL')).toBe('Left voicemail');
      expect(labelFor('inventory', 'RESERVED')).toBe('Reserved');
    });

    it('humanize handles empty and lowercase inputs', () => {
      expect(humanize('')).toBe('');
      expect(humanize('NEW')).toBe('New');
      expect(humanize('no_show')).toBe('No show');
      expect(humanize('a')).toBe('A');
    });
  });
});
