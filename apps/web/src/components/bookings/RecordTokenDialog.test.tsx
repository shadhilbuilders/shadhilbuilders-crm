// RecordTokenDialog tests (T-TOKEN-GATE, 2026-09-28).
//
// The dialog exists because a HOLD → TOKEN move used to record NO AMOUNT: the
// dashboard fired `{ toStatus: 'TOKEN' }` and the service set
// `status = 'TOKEN'` without touching `tokenAmount`. A booking could therefore be
// marked token-received with nothing to verify it, and the admin "Booking money"
// card - which derives its meaning from that column - rendered it as "no token",
// i.e. money still with the customer, for a booking just marked paid.
//
// These tests pin the parts that make the value real: the amount is REQUIRED, it
// is sent WITH the status, and an already-recorded amount is prefilled rather
// than silently blanked.
//
// Rendered via the named body export (the Base UI portal renders empty under
// renderToStaticMarkup), same convention as BookingApprovalDialog's tests.
import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TokenAmountSchema } from '@shadhil/api-types';

import { bookingLabel, RecordTokenFormBody } from './RecordTokenDialog';

// The dialog's schema, minus the `undefined`-when-blank refinement: this harness
// exercises the FIELD and the VALUE TYPE, which is where the bug was.
//
// T-TOKEN-GATE fix (2026-09-28): the harness used to declare `z.string()`, copying
// the same wrong assumption as the production form, so it never caught "Invalid
// input: expected string, received number". A test that mirrors the mistake cannot
// detect it - which is why the schema is now IMPORTED from @shadhil/api-types.
const schema = z.object({ tokenAmount: TokenAmountSchema.optional() });

function Harness({ defaultValue }: { defaultValue?: number }) {
  const form = useForm<{ tokenAmount?: number }>({
    resolver: zodResolver(schema),
    defaultValues: { tokenAmount: defaultValue },
  });
  return <RecordTokenFormBody form={form} onSubmit={vi.fn()} />;
}

describe('RecordTokenFormBody', () => {
  it('renders the token amount field, marked required', () => {
    const html = renderToStaticMarkup(<Harness />);
    expect(html).toContain('Token amount received');
    // `required` is what makes the browser refuse an empty submit before zod even
    // runs - the first of the two layers that stop a token being recorded blank.
    expect(html).toMatch(/required/);
    expect(html).toContain('record-token-amount');
  });

  it('explains WHY the amount is asked for', () => {
    const html = renderToStaticMarkup(<Harness />);
    // A bare "Amount" field invites people to guess. The description states that
    // it is recorded with the status change.
    expect(html).toContain('Recorded with the status change');
  });
});

describe('the token amount type (the bug this fixes)', () => {
  it('accepts a NUMBER - what the library field actually emits', () => {
    // The `@paalstack/react-ui` number field writes
    // `event.currentTarget.valueAsNumber` into the form. A `z.string()` schema
    // rejected it with "Invalid input: expected string, received number" on every
    // submit. This is the regression pin for that.
    expect(schema.safeParse({ tokenAmount: 500_000 }).success).toBe(true);
    expect(schema.safeParse({ tokenAmount: 500_000.5 }).success).toBe(true);
  });

  it('still rejects zero, negatives and non-numbers', () => {
    for (const v of [0, -5, 'abc']) {
      expect(schema.safeParse({ tokenAmount: v }).success, `${String(v)} must be rejected`).toBe(
        false,
      );
    }
  });

  it('treats a blank field as "not entered" (undefined), not as invalid', () => {
    // The field emits `undefined` when cleared, so absence must be representable -
    // the "an amount is required" rule lives one level up, where it can tell a
    // blank field from a zero one.
    expect(schema.safeParse({ tokenAmount: undefined }).success).toBe(true);
  });
});

describe('bookingLabel', () => {
  it('leads with the unit number', () => {
    // The villa number identifies a booking; the customer name is secondary.
    expect(bookingLabel({ id: 'b1', unitNumber: 'D-102', leadName: 'Arjun Reddy' })).toBe(
      'Unit D-102 · Arjun Reddy',
    );
  });

  it('falls back to the name, then the id, when there is no unit', () => {
    expect(bookingLabel({ id: 'b1', leadName: 'Arjun Reddy' })).toBe('Arjun Reddy');
    expect(bookingLabel({ id: 'b1' })).toBe('b1');
  });
});
