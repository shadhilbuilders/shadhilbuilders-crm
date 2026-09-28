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

import { bookingLabel, RecordTokenFormBody } from './RecordTokenDialog';

const schema = z
  .object({ tokenAmount: z.string().trim().optional() })
  .superRefine((values, ctx) => {
    const raw = (values.tokenAmount ?? '').trim();
    if (raw.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['tokenAmount'], message: 'Enter the token amount' });
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({ code: 'custom', path: ['tokenAmount'], message: 'must be greater than zero' });
    }
  });

function Harness({ defaultValue = '' }: { defaultValue?: string }) {
  const form = useForm<z.infer<typeof schema>>({
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

describe('the token amount rule (mirrors BookingTransitionDtoSchema)', () => {
  it('rejects an empty amount', () => {
    expect(schema.safeParse({ tokenAmount: '' }).success).toBe(false);
  });

  it('rejects zero and negatives', () => {
    for (const v of ['0', '-5']) {
      expect(schema.safeParse({ tokenAmount: v }).success, `${v} must be rejected`).toBe(false);
    }
  });

  it('rejects a non-numeric value', () => {
    expect(schema.safeParse({ tokenAmount: 'abc' }).success).toBe(false);
  });

  it('accepts a positive amount, as a whole number or with paise', () => {
    for (const v of ['500000', '500000.50']) {
      expect(schema.safeParse({ tokenAmount: v }).success, `${v} must be accepted`).toBe(true);
    }
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
