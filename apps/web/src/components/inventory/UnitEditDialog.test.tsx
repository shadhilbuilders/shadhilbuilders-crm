// UnitEditDialog - props-API Form surface (jsdom portal rule: render the
// exported UnitEditFormBody, not the Dialog shell).
//
// Pins: the form renders all editable fields (unitNumber, bhk, facing,
// sqft, price, status); the data-qa attributes are forwarded.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/inventory', () => ({
  useUpdateUnit: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

import { UnitEditFormBody } from './UnitEditDialog';

const UNIT = {
  id: 'unit-1',
  unitNumber: 'A-101',
  bhk: 3,
  facing: 'North',
  sqft: 1450,
  price: '5800000.00',
  status: 'AVAILABLE',
};

describe('UnitEditFormBody - props-API Form surface', () => {
  it('renders all editable fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(
      <UnitEditFormBody unit={UNIT} onSubmit={() => undefined} />,
    );

    expect(html).toContain('Unit number');
    expect(html).toContain('BHK');
    expect(html).toContain('Facing');
    expect(html).toContain('Sqft');
    expect(html).toContain('Price (₹)');
    expect(html).toContain('Status');

    // data-qa regression canaries
    expect(html).toMatch(/data-qa="unit-edit-number"/);
    expect(html).toMatch(/data-qa="unit-edit-bhk"/);
    expect(html).toMatch(/data-qa="unit-edit-facing"/);
    expect(html).toMatch(/data-qa="unit-edit-sqft"/);
    expect(html).toMatch(/data-qa="unit-edit-price"/);
  });
});
