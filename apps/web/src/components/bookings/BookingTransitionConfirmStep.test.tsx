// BookingTransitionConfirmStep - the confirm step of a booking status change.
//
// The layout ORDER is the feature here (user direction, 2026-09-15): "Move from
// X to Y" must render BEFORE the reason textarea, so the operator reads which
// move they are confirming before being asked to justify it. The first version
// rendered the Form first, which asked for a justification before showing the
// move. The page's own static render only ever shows step 1, which is why this
// block lives in its own file and is asserted directly.
import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransitionReasonRequired } from '@shadhil/api-types';
import {
  BookingTransitionConfirmStep,
  type TransitionFormValues,
} from './BookingTransitionConfirmStep';

const schema = z
  .object({
    toStatus: z.enum(['TOKEN', 'APPROVED', 'REJECTED', 'CANCELLED']),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((values, ctx) => {
    if (!TransitionReasonRequired.has(values.toStatus)) return;
    if ((values.reason ?? '').trim().length > 0) return;
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required' });
  });

function Step({ target }: { target: 'CANCELLED' | 'TOKEN' }) {
  const form = useForm<TransitionFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { toStatus: target, reason: '' },
    mode: 'onSubmit',
  });
  return (
    <BookingTransitionConfirmStep
      form={form}
      onSubmit={() => undefined}
      currentStatus='HOLD'
      toStatus={target}
      reasonRequired={TransitionReasonRequired.has(target)}
      isPending={false}
      onCancelStep={() => undefined}
    />
  );
}

describe('BookingTransitionConfirmStep', () => {
  it('renders "Move from" BEFORE the reason textarea', () => {
    const html = renderToStaticMarkup(<Step target='CANCELLED' />);
    const contextAt = html.indexOf('data-qa="booking-transition-context"');
    const reasonAt = html.indexOf('data-qa="booking-reason"');
    expect(contextAt, 'context block missing').toBeGreaterThan(-1);
    expect(reasonAt, 'reason field missing').toBeGreaterThan(-1);
    expect(contextAt).toBeLessThan(reasonAt);
  });

  it('renders the move-from and move-to labels in the context row', () => {
    const html = renderToStaticMarkup(<Step target='CANCELLED' />);
    // "Move from <current> to <target>" - friendly labels, not raw enums.
    expect(html).toContain('Move from');
    expect(html).toContain('Cancelled');
  });

  it('puts the confirm/cancel actions after the reason field', () => {
    const html = renderToStaticMarkup(<Step target='CANCELLED' />);
    expect(html.indexOf('data-qa="booking-reason"')).toBeLessThan(
      html.indexOf('data-qa="booking-confirm"'),
    );
  });

  it('marks the reason required for CANCELLED and optional for TOKEN', () => {
    const cancel = renderToStaticMarkup(<Step target='CANCELLED' />);
    const token = renderToStaticMarkup(<Step target='TOKEN' />);
    // The props-API Form renders the required marker as `required-indicator`
    // (data-qa), and the label/description flip with the transition.
    expect(cancel).toContain('required-indicator');
    expect(cancel).toContain('Required. Recorded in the audit log');
    expect(token).toContain('Reason (optional)');
    expect(token).not.toContain('required-indicator');
  });

  it('submits through the form (confirm is type=submit, bound to the form id)', () => {
    const html = renderToStaticMarkup(<Step target='CANCELLED' />);
    // Slice the WHOLE element: the library puts `form=` after the data-qa, so a
    // slice that stops at the marker would silently miss it.
    const at = html.indexOf('data-qa="booking-confirm"');
    const start = html.lastIndexOf('<button', at);
    const end = html.indexOf('</button>', at);
    const btn = html.slice(start, end);
    expect(btn).toContain('type="submit"');
    expect(btn).toContain('form="booking-transition-form"');
  });

  it('the Cancel action is type=button so it never submits the form', () => {
    const html = renderToStaticMarkup(<Step target='CANCELLED' />);
    const at = html.indexOf('data-qa="booking-transition-cancel"');
    const start = html.lastIndexOf('<button', at);
    const end = html.indexOf('</button>', at);
    expect(html.slice(start, end)).toContain('type="button"');
  });
});
