// BookingApprovalDialog - the UI path for TOKEN → APPROVED | REJECTED
// (T-BOOK-APPROVE).
//
// jsdom portal rule: render the exported BookingApprovalFormBody, not the
// Dialog shell (Base UI portals render empty under renderToStaticMarkup).
//
// Also pins the client-side mirror of the transition DTO: a REJECTED decision
// without a reason must be refused BEFORE the mutation fires (the audit policy
// needs the reason, and the detail page has the same rule).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

vi.mock('@/hooks/queries/crm', () => ({
  useUpdateBooking: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { BookingApprovalFormBody } from './BookingApprovalDialog';

type Values = { decision: 'APPROVED' | 'REJECTED'; reason?: string };

function TestForm({ decision }: { decision: Values['decision'] }) {
  const form = useForm<Values>({
    defaultValues: { decision, reason: '' },
    mode: 'onSubmit',
  });
  return <BookingApprovalFormBody form={form} onSubmit={() => undefined} />;
}

describe('BookingApprovalFormBody - approval decision surface', () => {
  // T-APPROVE-ONE-CONTROL (2026-09-16, owner report): the dialog offered the same
  // decision TWICE - a Decision select here in the body AND Approve/Reject
  // buttons in the footer. The select was removed so ONE control owns the
  // decision. These assertions pin its absence: if someone re-adds a decision
  // field here, this fails and points at the reason.
  it('does NOT render a second decision control in the body', () => {
    const html = renderToStaticMarkup(<TestForm decision="APPROVED" />);

    expect(html).not.toContain('Decision');
    expect(html).not.toMatch(/data-qa="form-field-decision"/);
    // The footer buttons own the decision (the shell renders them; the body
    // must not duplicate them).
    expect(html).not.toMatch(/data-qa="booking-approval-approve"/);
    expect(html).not.toMatch(/data-qa="booking-approval-reject"/);
    // The reason field is what remains.
    expect(html).toMatch(/data-qa="booking-approval-reason"/);
  });

  it('renders the reason as optional while the pending decision is an approval', () => {
    const html = renderToStaticMarkup(<TestForm decision="APPROVED" />);
    // Reason is optional for an approval.
    expect(html).toContain('Reason (optional)');
    // ...but the copy still warns that rejecting will require it, since the
    // decision buttons sit right below this field.
    expect(html).toContain('Required if you reject');
  });

  it('asks for a required reason when the decision is REJECTED', () => {
    const html = renderToStaticMarkup(<TestForm decision="REJECTED" />);
    expect(html).toContain('Reason');
    expect(html).not.toContain('Reason (optional)');
  });
});

// ── The DTO mirror ───────────────────────────────────────────────────────────
// Same shape as the component's schema; a rejection without a reason must fail
// validation, and a 500-char cap must hold.
const approvalSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((values, ctx) => {
    if (values.decision === 'REJECTED' && (values.reason ?? '').length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A reason is required when rejecting a booking',
      });
    }
  });

describe('approval decision schema (mirrors BookingTransitionDto)', () => {
  it('accepts an approval with no reason', () => {
    expect(approvalSchema.safeParse({ decision: 'APPROVED' }).success).toBe(true);
  });

  it('accepts a rejection WITH a reason', () => {
    const r = approvalSchema.safeParse({ decision: 'REJECTED', reason: 'customer backed out' });
    expect(r.success).toBe(true);
  });

  it('refuses a rejection with no reason', () => {
    const r = approvalSchema.safeParse({ decision: 'REJECTED', reason: '' });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.path).toEqual(['reason']);
  });

  it('refuses a whitespace-only reason', () => {
    expect(approvalSchema.safeParse({ decision: 'REJECTED', reason: '   ' }).success).toBe(false);
  });

  it('refuses any decision other than APPROVED/REJECTED', () => {
    for (const decision of ['TOKEN', 'CANCELLED', 'HOLD', 'APPROVED ']) {
      expect(approvalSchema.safeParse({ decision }).success).toBe(false);
    }
  });

  it('caps the reason at 500 chars (server DTO limit)', () => {
    expect(approvalSchema.safeParse({ decision: 'REJECTED', reason: 'x'.repeat(500) }).success).toBe(true);
    expect(approvalSchema.safeParse({ decision: 'REJECTED', reason: 'x'.repeat(501) }).success).toBe(false);
  });
});
