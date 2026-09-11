// UnitEditDialog - props-API Form surface (jsdom portal rule: render the
// exported UnitEditFormBody, not the Dialog shell).
//
// Pins: the form renders all editable fields (unitNumber, bhk, facing,
// sqft, price, status); the data-qa attributes are forwarded.
//
// The body receives the Dialog's single `useForm` instance as a prop
// (user-mandated: one form per dialog), so the test wraps it in a tiny
// TestForm that owns the useForm call.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useForm } from 'react-hook-form';

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

function TestForm() {
  const form = useForm<{
    unitNumber: string;
    bhk: string;
    facing?: string;
    sqft?: string;
    price: string;
    status: string;
  }>({
    defaultValues: {
      unitNumber: UNIT.unitNumber,
      bhk: String(UNIT.bhk),
      facing: UNIT.facing,
      sqft: String(UNIT.sqft),
      price: UNIT.price,
      status: UNIT.status,
    },
    mode: 'onSubmit',
  });
  return (
    <UnitEditFormBody
      form={form}
      onSubmit={() => undefined}
      bhkOptions={[{ value: '1', label: '1 BHK' }, { value: '2', label: '2 BHK' }, { value: '3', label: '3 BHK' }]}
      facingOptions={[{ value: 'North', label: 'North' }, { value: 'South', label: 'South' }]}
    />
  );
}

describe('UnitEditFormBody - props-API Form surface', () => {
  it('renders all editable fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(<TestForm />);

    expect(html).toContain('Unit number');
    expect(html).toContain('BHK');
    expect(html).toContain('Facing');
    expect(html).toContain('Sqft');
    expect(html).toContain('Price (₹)');
    expect(html).toContain('Status');

    // data-qa regression canaries
    expect(html).toMatch(/data-qa="unit-edit-number"/);
    expect(html).toMatch(/data-qa="unit-edit-sqft"/);
    expect(html).toMatch(/data-qa="unit-edit-price"/);

    // BHK and Facing are Selects (bounded pickers from the shared
    // constants). The Select trigger hardcodes data-qa="select-trigger"
    // (custom selectProps.data-qa is dropped), so assert on the field
    // wrapper data-qa instead.
    expect(html).toMatch(/data-qa="form-field-bhk"/);
    expect(html).toMatch(/data-qa="form-field-facing"/);
  });
});
