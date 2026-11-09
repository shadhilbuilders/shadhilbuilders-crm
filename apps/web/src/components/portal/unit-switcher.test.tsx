// UnitSwitcher (issue #8 slice 2, design D4).
// protects= the control exists ONLY for 2+ units, marks the selection and has
//           44px targets; fails_when= a lone unit gets a chip, or the selected
//           chip is not exposed via aria-pressed; no_claim= no click handling.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PortalUnit } from '@/hooks/queries/customer-portal';

import { UnitSwitcher } from './unit-switcher';

const unit = (unitId: string, unitNumber: string): PortalUnit => ({
  unitId,
  unitNumber,
  projectName: 'Metro Heights',
  projectId: 'p1',
  currentPhaseName: null,
  expectedHandoverDate: null,
  milestones: [],
  photoCount: 0,
  plotNumber: null,
  bhk: 2,
  facing: null,
  plotSqft: null,
  buildupSqft: '1090.00',
  pricePerSqft: '4018.35',
  listAmount: '4380000.00',
  phaseName: null,
  negotiatedRate: null,
  negotiatedAmount: null,
  finalAmount: '4380000.00',
  isNegotiated: false,
  tokenAmount: null,
});

describe('UnitSwitcher', () => {
  it('renders nothing for zero or one unit', () => {
    expect(renderToStaticMarkup(<UnitSwitcher units={[]} selectedUnitId={null} onSelect={() => undefined} />)).toBe('');
    expect(
      renderToStaticMarkup(<UnitSwitcher units={[unit('a', 'A-1')]} selectedUnitId="a" onSelect={() => undefined} />),
    ).toBe('');
  });

  it('renders one chip per unit with the selected one pressed, for 2+ units', () => {
    const html = renderToStaticMarkup(
      <UnitSwitcher units={[unit('a', 'A-1'), unit('b', 'A-2')]} selectedUnitId="b" onSelect={() => undefined} />,
    );
    expect(html.match(/data-qa="unit-switcher-chip"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(html.match(/min-h-11/g)?.length).toBe(2);
  });
});
