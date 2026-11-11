// PortalUnitRecord (2026-11-09): the buyer's own unit record and price.
//
// protects= every figure the office quotes is on screen, the list vs negotiated
//           split stays honest, the amount they PAY is labelled explicitly, and
//           an unrecorded field says so instead of rendering a guess;
// fails_when= a null plot/facing renders "0" or "-", the negotiated row shows
//           when nothing was negotiated, or the pay figure is ambiguous;
// no_claim= static markup only: no formatting of the live API response.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PortalUnit } from '@/hooks/queries/customer-portal';

import { PortalUnitRecord } from './portal-unit-record';

const base: PortalUnit = {
  unitId: 'u1',
  unitNumber: 'A-101',
  projectName: 'Shadhil Metro Heights',
  projectId: 'p1',
  currentPhaseName: 'Phase C',
  photoCount: 2,
  expectedHandoverDate: null,
  milestones: [],
  plotNumber: 41,
  bhk: 2,
  facing: 'North',
  plotSqft: 1090,
  buildupSqft: '1090.00',
  pricePerSqft: '4018.35',
  listAmount: '4380000.00',
  phaseName: 'Phase C',
  negotiatedRate: null,
  negotiatedAmount: null,
  finalAmount: '4380000.00',
  isNegotiated: false,
  tokenAmount: null,
};

const render = (over: Partial<PortalUnit> = {}) =>
  renderToStaticMarkup(<PortalUnitRecord unit={{ ...base, ...over }} />);

describe('PortalUnitRecord', () => {
  it('shows every figure the office quotes, formatted for India', () => {
    const html = render();
    expect(html).toContain('Plot number');
    expect(html).toContain('41');
    expect(html).toContain('2 BHK');
    expect(html).toContain('North');
    expect(html).toContain('1,090 sq.ft');
    expect(html).toContain('Phase C');
    expect(html).toContain('Shadhil Metro Heights');
    // Indian grouping + rupee symbol.
    expect(html).toContain('4,018.35');
    expect(html).toContain('43,80,000.00');
  });

  // 2026-11-09: the record now uses the hero note's eyebrow-then-display rhythm
  // (a small upper-case label over a display-weight line) instead of an eyebrow
  // dropping straight into label/value rows.
  it('titles the unit and the price with the hero note\u2019s display rhythm', () => {
    const html = render();
    expect(html).toContain('portal-eyebrow mb-1.5');
    expect(html.match(/portal-display mb-3/g) ?? []).toHaveLength(2);
    // The unit's display line is its number.
    expect(html).toContain('A-101');
  });

  // 2026-11-09: the two halves sit side by side from sm instead of stacking,
  // because they answer one question together.
  it('lays the unit and price out as two columns from sm', () => {
    const html = render();
    expect(html).toContain('sm:grid-cols-2');
    expect(html.match(/grid-cols-1/g) ?? []).toHaveLength(1);
  });

  // 2026-11-09: with no negotiation, finalAmount === listAmount, so a "You pay"
  // row repeating the headline figure was pure noise. It is now omitted.
  it('omits the You pay row when nothing was negotiated', () => {
    const html = render();
    expect(html).not.toContain('You pay');
    expect(html).not.toContain('Negotiated');
    expect(html).toContain('List price');
    // The balance still closes the block.
    expect(html).toContain('Balance due');
  });

  it('shows what is still owed, and the token that reduced it', () => {
    const html = render({ tokenAmount: '500000.00' });
    expect(html).toContain('Token paid');
    expect(html).toContain('5,00,000.00');
    expect(html).toContain('Balance due');
    // 43,80,000 - 5,00,000 = 38,80,000.
    expect(html).toContain('38,80,000.00');
  });

  // An unrecorded token is NOT a zero payment: printing "₹0 paid" would tell the
  // buyer nothing was received when the office simply has not entered it.
  it('omits the token row entirely when none is recorded', () => {
    const html = render({ tokenAmount: null });
    expect(html).not.toContain('Token paid');
    // ...but the full amount is still due.
    expect(html).toContain('Balance due');
  });

  it('never renders a negative balance when the token exceeds the total', () => {
    const html = render({ tokenAmount: '5000000.00' });
    expect(html).toContain('Balance due');
    expect(html).not.toMatch(/-\u20b9|-Rs/);
    expect(html).toContain('0.00');
  });

  it('keeps BOTH totals when the deal was negotiated', () => {
    const html = render({
      negotiatedRate: '3900.00',
      negotiatedAmount: '4251000.00',
      finalAmount: '4251000.00',
      isNegotiated: true,
    });
    // The saving is visible only if the list total survives beside it.
    expect(html).toContain('43,80,000.00');
    expect(html).toContain('Negotiated rate');
    expect(html).toContain('3,900.00');
    expect(html).toContain('Negotiated');
    expect(html).toContain('42,51,000.00');
    expect(html).toContain('You pay');
    expect(html).not.toContain('List price. Any agreed discount');
    // Negotiated deals DO keep the row, where it differs from the list total.
    expect(html).toContain('You pay');
  });

  it('says so instead of guessing when the unit records nothing', () => {
    const html = render({ plotNumber: null, facing: null, plotSqft: null });
    expect(html).toContain('Not recorded');
    // A null must never be rendered as a zero or a dash that reads as data.
    expect(html).not.toMatch(/Plot number[\s\S]{0,120}>0</);
    expect(html).not.toMatch(/Facing[\s\S]{0,120}>-</);
  });
});
