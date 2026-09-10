// T-BOOK - BookingEditFormBody wire-shape contract.
//
// Pins: the props-API Form renders all editable fields (Total amount,
// Token amount, Notes); the form body is exported separately so tests
// can render it without the Dialog portal (jsdom rule).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BookingEditFormBody } from './BookingEditDialog';

describe('BookingEditFormBody - props-API Form surface (T-BOOK)', () => {
  it('renders all editable fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(
      <BookingEditFormBody
        booking={{
          id: 'b-1',
          leadName: 'Priya Sharma',
          amount: '7500000',
          tokenAmount: '500000',
          notes: 'some note',
        }}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain('Total amount (₹)');
    expect(html).toContain('Token amount (₹, optional)');
    expect(html).toContain('Notes');
    expect(html).toMatch(/data-qa="booking-edit-amount"/);
    expect(html).toMatch(/data-qa="booking-edit-token-amount"/);
    expect(html).toMatch(/data-qa="booking-edit-notes"/);
  });
});
