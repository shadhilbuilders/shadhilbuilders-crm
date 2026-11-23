// How a villa is named to a buyer in a WhatsApp message.
//
// protects= the plot number is included when the villa has one, and simply
// absent when it does not - never "plot null", never "plot " with a trailing
// space, never a second template slot that would need its own empty-value case.
// fails_when= a nullable plot produces a malformed label, or the door number
// stops being what the buyer recognises first.
import { describe, expect, it } from 'vitest';

import { villaLabel } from './site-update-villa';

describe('villaLabel', () => {
  it('adds the plot in brackets after the door number', () => {
    expect(villaLabel('A-101', 37)).toBe('A-101 (plot 37)');
  });

  it('is just the door number when the villa is not on the layout yet', () => {
    // plotNumber is nullable in the schema: a villa can be entered before it is
    // placed on the layout, so a separate template slot could never be filled.
    expect(villaLabel('A-101', null)).toBe('A-101');
    expect(villaLabel('A-101', undefined)).toBe('A-101');
  });

  it('keeps plot 0, which is a real plot number', () => {
    expect(villaLabel('A-101', 0)).toBe('A-101 (plot 0)');
  });

  it('never prints NaN or a broken bracket', () => {
    expect(villaLabel('A-101', Number.NaN)).toBe('A-101');
  });
});
