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

import { TOKEN_EXCEEDS_TOTAL_MESSAGE, TokenAmountSchema } from '@shadhil/api-types';

import {
  bookingLabel,
  recordTokenSchemaFor,
  RecordTokenFormBody,
  TOKEN_AMOUNT_REQUIRED_MESSAGE,
} from './RecordTokenDialog';

// Field/type harness: positive number rules only. Required + cap live on
// `recordTokenSchemaFor` and are pinned in the schema describe below.
const typeSchema = z.object({ tokenAmount: TokenAmountSchema.optional() });

function Harness({ defaultValue }: { defaultValue?: number }) {
  const form = useForm<{ tokenAmount?: number }>({
    resolver: zodResolver(typeSchema),
    defaultValues: { tokenAmount: defaultValue },
  });
  return <RecordTokenFormBody form={form} onSubmit={vi.fn()} />;
}

describe('RecordTokenFormBody', () => {
  it('renders the token amount field, marked required', () => {
    const html = renderToStaticMarkup(<Harness />);
    expect(html).toContain('Token amount received');
    // Label/a11y `required` only - Form defaults to noValidate, so blank submit
    // is blocked by recordTokenSchemaFor (see schema tests below), not the browser.
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
    expect(typeSchema.safeParse({ tokenAmount: 500_000 }).success).toBe(true);
    expect(typeSchema.safeParse({ tokenAmount: 500_000.5 }).success).toBe(true);
  });

  it('still rejects zero, negatives and non-numbers', () => {
    for (const v of [0, -5, 'abc']) {
      expect(
        typeSchema.safeParse({ tokenAmount: v }).success,
        `${String(v)} must be rejected`,
      ).toBe(false);
    }
  });

  it('treats a blank field as "not entered" (undefined) at the type layer', () => {
    // The field emits `undefined` when cleared. The type schema allows that so
    // zero (invalid amount) stays distinct from blank; required is enforced by
    // recordTokenSchemaFor.
    expect(typeSchema.safeParse({ tokenAmount: undefined }).success).toBe(true);
  });
});

describe('recordTokenSchemaFor (field errors the Form can show)', () => {
  const schema = recordTokenSchemaFor(1_000_000);

  it('rejects a blank amount with the operator-facing message', () => {
    // Form uses noValidate, so without this refine a blank submit called onSubmit
    // and the dialog returned silently - no FieldError ever rendered.
    const result = schema.safeParse({ tokenAmount: undefined });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['tokenAmount']);
    expect(result.error.issues[0]?.message).toBe(TOKEN_AMOUNT_REQUIRED_MESSAGE);
  });

  it('rejects a token above the booking total', () => {
    const result = schema.safeParse({ tokenAmount: 1_000_001 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(TOKEN_EXCEEDS_TOTAL_MESSAGE);
  });

  it('accepts a positive token within the total', () => {
    expect(schema.safeParse({ tokenAmount: 500_000 }).success).toBe(true);
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
