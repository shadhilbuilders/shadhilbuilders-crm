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

import { UnitEditFormBody, fromDateInput, toDateInput } from './UnitEditDialog';

const UNIT = {
  id: 'unit-1',
  unitNumber: 'A-101',
  bhk: 3,
  facing: 'North',
  sqft: 1450,
  buildupSqft: '1450.00',
  pricePerSqft: '4000.00',
  price: '5800000.00',
  status: 'AVAILABLE',
};

function TestForm({ status = 'AVAILABLE' }: { status?: string }) {
  const form = useForm<{
    unitNumber: string;
    bhk: string;
    facing?: string;
    sqft?: string;
    buildupSqft: string;
    pricePerSqft: string;
    price?: string;
    status: string;
  }>({
    defaultValues: {
      unitNumber: UNIT.unitNumber,
      bhk: String(UNIT.bhk),
      facing: UNIT.facing,
      sqft: String(UNIT.sqft),
      buildupSqft: '1450.00',
      pricePerSqft: '4000.00',
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
    expect(html).toContain('Plot sq.ft');
    expect(html).toContain('Buildup sq.ft');
    expect(html).toContain('Per sq.ft price (₹)');
    expect(html).toContain('Total sq.ft price (₹)');
    expect(html).toContain('Status');

    // data-qa regression canaries
    expect(html).toMatch(/data-qa="unit-edit-number"/);
    expect(html).toMatch(/data-qa="unit-edit-sqft"/);
    expect(html).toMatch(/data-qa="unit-edit-price"/);
    expect(html).toMatch(/data-qa="unit-edit-buildup-sqft"/);
    expect(html).toMatch(/data-qa="unit-edit-price-per-sqft"/);

    // BHK and Facing are Selects (bounded pickers from the shared
    // constants). The Select trigger hardcodes data-qa="select-trigger"
    // (custom selectProps.data-qa is dropped), so assert on the field
    // wrapper data-qa instead.
    expect(html).toMatch(/data-qa="form-field-bhk"/);
    expect(html).toMatch(/data-qa="form-field-facing"/);
  });

  it('renders the unit total as a read-only, auto-calculated field', () => {
    const html = renderToStaticMarkup(<TestForm />);
    const total = html.match(/<input[^>]*data-qa="unit-edit-price"[^>]*>/)?.[0] ?? '';
    expect(total).toMatch(/readonly/i);
    // The editable rate fields must NOT be read-only.
    const rate = html.match(/<input[^>]*data-qa="unit-edit-price-per-sqft"[^>]*>/)?.[0] ?? '';
    expect(rate).not.toMatch(/readonly/i);
  });

  // The dialog caps its own height and pins header/footer, so the form is the
  // scroll container for the field list. Without it the lower fields (and the
  // footer's Save button) fall below the fold on short viewports.
  it('makes the field list the dialog scroll container', () => {
    const html = renderToStaticMarkup(<TestForm />);
    const form = html.match(/<form[^>]*data-qa="form"[^>]*>/)?.[0] ?? '';

    expect(form).toMatch(/overflow-y-auto/);
    expect(form).toMatch(/min-h-0/);
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

describe('handover date field', () => {
  it('renders the buyer-visible handover date input', () => {
    const html = renderToStaticMarkup(<TestForm />);
    expect(html).toContain('Expected handover');
    expect(html).toMatch(/<input[^>]*type="date"[^>]*data-qa="unit-edit-handover"|<input[^>]*data-qa="unit-edit-handover"[^>]*type="date"/);
  });

  it('round-trips a calendar day without shifting it, and blank clears', () => {
    expect(toDateInput('2027-06-30T00:00:00.000Z')).toBe('2027-06-30');
    expect(toDateInput(null)).toBe('');
    expect(toDateInput(undefined)).toBe('');
    expect(fromDateInput('2027-06-30')).toBe('2027-06-30T00:00:00.000Z');
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput(undefined)).toBeNull();
  });
});
