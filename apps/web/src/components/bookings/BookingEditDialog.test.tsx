// T-BOOK - BookingEditFormBody wire-shape contract.
//
// Pins: the props-API Form renders all editable fields (Total amount,
// Token amount, Notes); the form body is exported separately so tests
// can render it without the Dialog portal (jsdom rule). It receives the
// single `form` instance owned by the Dialog.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { BookingEditFormBody } from './BookingEditDialog';

const schema = z.object({
  amount: z.string(),
  tokenAmount: z.string().optional(),
  notes: z.string().optional(),
});

function TestForm() {
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { amount: '7500000', tokenAmount: '500000', notes: 'some note' },
    mode: 'onSubmit',
  });
  return <BookingEditFormBody form={form} onSubmit={() => {}} />;
}

describe('BookingEditFormBody - props-API Form surface (T-BOOK)', () => {
  it('renders all editable fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(<TestForm />);

    expect(html).toContain('Total amount (₹)');
    // T-TOKEN-GATE: the label lost its ", optional" suffix - the amount is
    // required on a TOKEN booking, so calling it optional was already wrong.
    expect(html).toContain('Token amount (₹)');
    expect(html).toContain('Notes');
    expect(html).toMatch(/data-qa="booking-edit-amount"/);
    expect(html).toMatch(/data-qa="booking-edit-token-amount"/);
    expect(html).toMatch(/data-qa="booking-edit-notes"/);
  });
});
