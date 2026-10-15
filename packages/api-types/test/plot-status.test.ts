// Plot availability contract.
//
// The mapping and the unit-number bridge are the two rules the whole map
// depends on, so they are pinned here rather than only exercised through the
// backend service. A wrong bridge silently paints the wrong plots, and a wrong
// status mapping paints a sold plot green.

import { describe, expect, it } from 'vitest';

import {
  BOOKING_STATUS_BINDING_ORDER,
  PLOT_STATUS_BINDING_ORDER,
  PLOT_STATUS_FROM_UNIT_STATUS,
  PlotStatusListResultSchema,
  PlotStatusRowSchema,
  UNIT_STATUS_BINDING_ORDER,
  bookingClaimRank,
  mostBindingPlotStatus,
  plotStatusFromUnitStatus,
  unitClaimRank,
} from '../src/plot-status';
import { MAX_PLOT_NUMBER, MIN_PLOT_NUMBER, PlotNumberSchema } from '../src/plot-number';
import { ACTIVE_BOOKING_STATUSES, UnitStatusSchema } from '../src/enums';

describe('plotStatusFromUnitStatus', () => {
  it('maps each unit lifecycle state to plot availability', () => {
    expect(plotStatusFromUnitStatus('AVAILABLE')).toBe('available');
    expect(plotStatusFromUnitStatus('SOLD')).toBe('booked');
    expect(plotStatusFromUnitStatus('HOLD')).toBe('blocked');
    expect(plotStatusFromUnitStatus('TOKEN')).toBe('blocked');
  });

  it('has an entry for every value in the UnitStatus enum', () => {
    // A new UnitStatus value must not silently fall through to `undefined`
    // and paint the plot with an unknown colour.
    for (const status of UnitStatusSchema.options) {
      expect(PLOT_STATUS_FROM_UNIT_STATUS[status]).toBeTruthy();
    }
    expect(Object.keys(PLOT_STATUS_FROM_UNIT_STATUS)).toHaveLength(UnitStatusSchema.options.length);
  });

  it('never lets a sold plot read as available or blocked', () => {
    expect(plotStatusFromUnitStatus('SOLD')).toBe('booked');
  });
});

describe('PlotNumberSchema', () => {
  it('accepts every plot number the layout defines', () => {
    expect(PlotNumberSchema.parse(MIN_PLOT_NUMBER)).toBe(1);
    expect(PlotNumberSchema.parse(37)).toBe(37);
    expect(PlotNumberSchema.parse(MAX_PLOT_NUMBER)).toBe(125);
  });

  it('refuses numbers outside the traced layout', () => {
    // A number off the layout would join to no polygon and vanish from the map
    // without saying so, which reads as a missing villa rather than bad input.
    expect(PlotNumberSchema.safeParse(0).success).toBe(false);
    expect(PlotNumberSchema.safeParse(126).success).toBe(false);
    expect(PlotNumberSchema.safeParse(-37).success).toBe(false);
  });

  it('refuses a fractional or non-numeric plot number', () => {
    // Plot numbers are positions on a drawing, not measurements.
    expect(PlotNumberSchema.safeParse(37.5).success).toBe(false);
    expect(PlotNumberSchema.safeParse('37').success).toBe(false);
    expect(PlotNumberSchema.safeParse(null).success).toBe(false);
    expect(PlotNumberSchema.safeParse(undefined).success).toBe(false);
  });

  it('is nullable only at the call site, never inside the schema', () => {
    // "No plot assigned" is a real state; a sentinel like 0 inside the range
    // would be indistinguishable from a real plot number.
    expect(PlotNumberSchema.nullable().safeParse(null).success).toBe(true);
  });
});

describe('mostBindingPlotStatus', () => {
  it('lets sold win over everything', () => {
    expect(mostBindingPlotStatus(['available', 'booked', 'blocked'])).toBe('booked');
  });

  it('lets a hold beat a free unit', () => {
    expect(mostBindingPlotStatus(['available', 'blocked'])).toBe('blocked');
  });

  it('is available when nothing claims the plot', () => {
    expect(mostBindingPlotStatus(['available', 'available'])).toBe('available');
    expect(mostBindingPlotStatus([])).toBe('available');
  });

  it('agrees with the binding order it is built from', () => {
    // The panel lists units in this order, so the first unit it shows has to be
    // the one this function took the colour from.
    for (const status of PLOT_STATUS_BINDING_ORDER) {
      expect(mostBindingPlotStatus([status, 'available'])).toBe(status);
    }
  });
});

describe('claim binding order', () => {
  it('ranks a sold unit ahead of token, hold and free', () => {
    expect(unitClaimRank('SOLD')).toBe(0);
    expect(unitClaimRank('TOKEN')).toBeLessThan(unitClaimRank('HOLD'));
    expect(unitClaimRank('HOLD')).toBeLessThan(unitClaimRank('AVAILABLE'));
  });

  it('covers every unit status, so nothing silently sorts last', () => {
    // A new UnitStatus without a rank would be presented after AVAILABLE, i.e.
    // as the least binding claim, which is never what a new state means.
    expect(UNIT_STATUS_BINDING_ORDER).toHaveLength(UnitStatusSchema.options.length);
    for (const status of UnitStatusSchema.options) {
      expect(unitClaimRank(status)).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks an approved booking ahead of token and hold', () => {
    expect(bookingClaimRank('APPROVED')).toBe(0);
    expect(bookingClaimRank('TOKEN')).toBeLessThan(bookingClaimRank('HOLD'));
  });

  it('sorts a terminal booking last, so it can never read as the claim', () => {
    // REJECTED/CANCELLED release the unit. If either ranked first, a cancelled
    // deal would be shown as the reason the villa is gone.
    expect(bookingClaimRank('CANCELLED')).toBe(BOOKING_STATUS_BINDING_ORDER.length);
    expect(bookingClaimRank('REJECTED')).toBe(BOOKING_STATUS_BINDING_ORDER.length);
    expect(bookingClaimRank('HOLD')).toBeLessThan(bookingClaimRank('CANCELLED'));
  });

  it('names exactly the statuses that claim a unit', () => {
    // The DB's partial unique index and the unit-status trigger use this same
    // list; the three must move together.
    expect([...BOOKING_STATUS_BINDING_ORDER].sort()).toEqual([...ACTIVE_BOOKING_STATUSES].sort());
  });
});

describe('wire schemas', () => {
  /** A unit row exactly as `UnitRowSchema` requires it on the wire. */
  const unitRow = {
    id: 'unit-37',
    phaseId: 'phase-cmda',
    phaseName: 'CMDA Plots',
    projectId: 'proj-1',
    projectName: 'Demo Villas',
    unitNumber: 'A-101',
    plotNumber: 37,
    bhk: 3,
    facing: 'East',
    sqft: 1450,
    buildupSqft: '1450.00',
    pricePerSqft: '4000.00',
    price: '5800000.00',
    status: 'SOLD',
    createdAt: '2026-10-01T09:00:00.000Z',
  };

  it('accepts a plot-status row and rejects an out-of-range plot number', () => {
    expect(PlotStatusRowSchema.parse({ plotNumber: 125, status: 'booked' })).toEqual({
      plotNumber: 125,
      status: 'booked',
      units: [],
    });
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 126, status: 'booked' }).success).toBe(
      false,
    );
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 0, status: 'booked' }).success).toBe(false);
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 1, status: 'sold' }).success).toBe(false);
  });

  it('carries the real unit and its booking through the row', () => {
    const row = {
      plotNumber: 37,
      status: 'booked',
      units: [
        {
          unit: unitRow,
          booking: {
            id: 'booking-1',
            status: 'APPROVED',
            amount: '5800000.00',
            tokenAmount: '250000.00',
            leadId: 'lead-1',
            leadName: 'Demo Vikram',
            createdAt: '2026-10-02T09:00:00.000Z',
          },
        },
      ],
    };
    expect(PlotStatusRowSchema.parse(row)).toEqual(row);
  });

  it('accepts a unit with no live booking', () => {
    // The honest shape for a free villa: the record exists, nothing holds it.
    const parsed = PlotStatusRowSchema.parse({
      plotNumber: 20,
      status: 'available',
      units: [
        {
          unit: { ...unitRow, unitNumber: 'D-103', plotNumber: 20, status: 'AVAILABLE' },
          booking: null,
        },
      ],
    });
    expect(parsed.units[0]?.booking).toBeNull();
    expect(parsed.units[0]?.unit.plotNumber).toBe(20);
  });

  it('rejects a unit claim that is not a unit row', () => {
    // A claim carrying only an id would render as a blank panel with a live
    // link, which is worse than a loud failure here.
    expect(
      PlotStatusRowSchema.safeParse({
        plotNumber: 37,
        status: 'booked',
        units: [{ unit: { id: 'unit-37' }, booking: null }],
      }).success,
    ).toBe(false);
  });

  it('rejects a booking whose status is not a booking status', () => {
    expect(
      PlotStatusRowSchema.safeParse({
        plotNumber: 37,
        status: 'booked',
        units: [
          {
            unit: unitRow,
            booking: {
              id: 'booking-1',
              status: 'SOLD',
              amount: '1.00',
              tokenAmount: null,
              leadId: 'lead-1',
              leadName: 'Demo Vikram',
              createdAt: '2026-10-02T09:00:00.000Z',
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty row set', () => {
    // The real case for a project that numbers its units by phase.
    expect(PlotStatusListResultSchema.parse({ rows: [] })).toEqual({ rows: [] });
  });
});
