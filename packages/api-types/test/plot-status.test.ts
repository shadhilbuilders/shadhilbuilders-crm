// Plot availability contract.
//
// The mapping and the unit-number bridge are the two rules the whole map
// depends on, so they are pinned here rather than only exercised through the
// backend service. A wrong bridge silently paints the wrong plots, and a wrong
// status mapping paints a sold plot green.

import { describe, expect, it } from 'vitest';

import {
  MAX_PLOT_NUMBER,
  MIN_PLOT_NUMBER,
  PLOT_NUMBER_STRINGS,
  PLOT_STATUS_FROM_UNIT_STATUS,
  PlotStatusListResultSchema,
  PlotStatusRowSchema,
  mostBindingPlotStatus,
  parsePlotNumber,
  plotStatusFromUnitStatus,
} from '../src/plot-status';
import { UnitStatusSchema } from '../src/enums';

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

describe('parsePlotNumber', () => {
  it('reads a bare integer as a plot number', () => {
    expect(parsePlotNumber('1')).toBe(1);
    expect(parsePlotNumber('37')).toBe(37);
    expect(parsePlotNumber('125')).toBe(125);
    expect(parsePlotNumber('  42  ')).toBe(42);
  });

  it('refuses the marketing numbering this repository actually uses', () => {
    // These are real unit numbers from the demo project. Treating "D-101" as
    // plot 101 would paint a plot that has nothing to do with that unit.
    expect(parsePlotNumber('D-101')).toBeNull();
    expect(parsePlotNumber('D-201')).toBeNull();
    expect(parsePlotNumber('A-12')).toBeNull();
    expect(parsePlotNumber('Villa 3')).toBeNull();
    expect(parsePlotNumber('PH1-01')).toBeNull();
  });

  it('refuses numbers outside the layout', () => {
    expect(parsePlotNumber('0')).toBeNull();
    expect(parsePlotNumber('126')).toBeNull();
    expect(parsePlotNumber('999')).toBeNull();
  });

  it('refuses forms Number() would happily coerce', () => {
    // `Number(' ')` is 0, `Number('1e2')` is 100, `Number('0x10')` is 16.
    // Coercion here would assign real plots to nonsense unit numbers.
    expect(parsePlotNumber(' ')).toBeNull();
    expect(parsePlotNumber('')).toBeNull();
    expect(parsePlotNumber('1e2')).toBeNull();
    expect(parsePlotNumber('0x10')).toBeNull();
    expect(parsePlotNumber('+37')).toBeNull();
    expect(parsePlotNumber('37.0')).toBeNull();
    expect(parsePlotNumber('-37')).toBeNull();
    expect(parsePlotNumber('NaN')).toBeNull();
  });

  it('refuses a zero-padded spelling, because the SQL pre-filter does too', () => {
    // The parser and the backend's `unitNumber IN (...)` filter must accept
    // exactly the same strings. The filter holds the canonical spellings, so
    // folding "037" onto plot 37 here would create a value the query can never
    // return - dead code that reads like support.
    expect(parsePlotNumber('037')).toBeNull();
    expect(parsePlotNumber('0037')).toBeNull();
    expect(parsePlotNumber('0125')).toBeNull();
  });
});

describe('PLOT_NUMBER_STRINGS', () => {
  it('covers 1-125 exactly, as the strings a unit number compares against', () => {
    expect(PLOT_NUMBER_STRINGS).toHaveLength(MAX_PLOT_NUMBER - MIN_PLOT_NUMBER + 1);
    expect(PLOT_NUMBER_STRINGS[0]).toBe('1');
    expect(PLOT_NUMBER_STRINGS[PLOT_NUMBER_STRINGS.length - 1]).toBe('125');
    // Every listed candidate must survive the parser, otherwise the SQL
    // pre-filter and the parse step would disagree about what a plot is.
    for (const candidate of PLOT_NUMBER_STRINGS) {
      expect(parsePlotNumber(candidate)).toBe(Number(candidate));
    }
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
});

describe('wire schemas', () => {
  it('accepts a plot-status row and rejects an out-of-range plot number', () => {
    expect(PlotStatusRowSchema.parse({ plotNumber: 125, status: 'booked' })).toEqual({
      plotNumber: 125,
      status: 'booked',
    });
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 126, status: 'booked' }).success).toBe(
      false,
    );
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 0, status: 'booked' }).success).toBe(false);
    expect(PlotStatusRowSchema.safeParse({ plotNumber: 1, status: 'sold' }).success).toBe(false);
  });

  it('accepts an empty row set', () => {
    // The real case today: no unit in the project is plot-numbered.
    expect(PlotStatusListResultSchema.parse({ rows: [] })).toEqual({ rows: [] });
  });
});
