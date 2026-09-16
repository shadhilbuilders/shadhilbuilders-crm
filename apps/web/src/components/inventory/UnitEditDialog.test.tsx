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

function TestForm({ status = 'AVAILABLE' }: { status?: string }) {
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
      status,
    },
    mode: 'onSubmit',
  });
  return (
    <UnitEditFormBody
      form={form}
      onSubmit={() => undefined}
      bhkOptions={[{ value: '1', label: '1 BHK' }, { value: '2', label: '2 BHK' }, { value: '3', label: '3 BHK' }]}
      facingOptions={[{ value: 'North', label: 'North' }, { value: 'South', label: 'South' }]}
      derivedStatus={status === 'HOLD' || status === 'TOKEN' ? status : null}
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

  // T-INV-SYNC follow-up: a held/token unit must NOT render the status picker.
  // It used to render a SELECT pre-selected with 'HOLD' - a value its options
  // (AVAILABLE|SOLD) cannot contain - and always submitted it, so the server
  // DTO rejected every save with a 400 and the unit became uneditable.
  it('shows the status read-only when a booking owns it (HOLD)', () => {
    const html = renderToStaticMarkup(<TestForm status='HOLD' />);

    expect(html).toMatch(/data-qa="unit-edit-status-derived"/);
    expect(html).toContain('Set by this unit&#x27;s booking');
    // No editable picker, and no hidden input carrying the derived value.
    expect(html).not.toMatch(/data-qa="unit-edit-status"/);
    expect(html).not.toMatch(/name="status"/);
    // Still fully usable for the fields that ARE editable.
    expect(html).toMatch(/data-qa="unit-edit-price"/);
  });

  it('shows the status read-only for TOKEN too', () => {
    const html = renderToStaticMarkup(<TestForm status='TOKEN' />);
    expect(html).toMatch(/data-qa="unit-edit-status-derived"/);
    expect(html).not.toMatch(/name="status"/);
  });

  it('keeps the editable picker for a status with no booking (AVAILABLE)', () => {
    const html = renderToStaticMarkup(<TestForm status='AVAILABLE' />);
    expect(html).toMatch(/data-qa="form-field-status"/);
    expect(html).not.toMatch(/data-qa="unit-edit-status-derived"/);
    expect(html).toMatch(/name="status"/);
  });
});
