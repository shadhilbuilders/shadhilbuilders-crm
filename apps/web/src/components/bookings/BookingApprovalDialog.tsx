'use client';

// BookingApprovalDialog - the UI path for TOKEN → APPROVED | REJECTED.
//
// T-BOOK-APPROVE (2026-09-15): approval used to be reachable only through a
// small "Review approval →" link buried inside the "Owner / Approval" cell of
// the bookings table, and only when the row happened to be TOKEN. This makes it
// a first-class row action in the table's Actions menu.
//
// Who may approve: MANAGER / ADMIN / OWNER (DESIGN.md §4 "Approve booking";
// the service gate uses the shared isAdminClass() helper and the page passes
// `canApproveBookings`). SALES_EXEC initiates but cannot approve.
//
// REJECTED requires a reason here (mirrors the detail page + the audit policy:
// the reason lands in the AuditLog row). APPROVED does not.
//
// T-APPROVE-ONE-CONTROL (2026-09-16, owner report): the dialog used to offer the
// SAME decision TWICE - a "Decision" select in the body AND Approve/Reject
// buttons in the footer. Two controls for one choice is not a shortcut, it is a
// question: which one wins, and why are they showing different things? The select
// is gone. ONE control remains, the footer pair, which is the pattern the user
// already reads as "this is what this dialog will do".
//
// The footer pair is still a single submit path: each button sets `decision` and
// then runs the SAME `handleSubmit(submit)`, so the rejection-reason rule is
// applied before the mutation fires either way.
//
// Two-API convention: the Dialog shell owns the single `useForm` instance; the
// form body is a separate named export so tests can render it without the
// Base UI portal (portals render empty under renderToStaticMarkup).
import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';

import { TransitionReasonRequired } from '@shadhil/api-types';
import { useUpdateBooking } from '@/hooks/queries/crm';
import { currencyIntl } from '@/lib/format';
import { labelFor, type BookingStatus } from '@/lib/labels';

const FORM_ID = 'booking-approval-form';

// Client-side mirror of BookingTransitionDto (packages/api-types/src/bookings.ts):
//   toStatus: BookingStatusSchema, reason?: string <= 500
// The decision is narrowed to the two approval outcomes; the server
// re-validates with the canonical DTO.
//
// Cross-field rule: a rejection must carry a reason. `.superRefine()` on the
// parent object (not field-level `.refine()`) so the issue is attached to
// `reason` and the form can highlight the right control. Never throw inside a
// refinement - collect the issue via ctx.addIssue().
const approvalSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().max(500, 'Reason must be under 500 characters').optional(),
  })
  .superRefine((values, ctx) => {
    // One definition of "this move needs a reason", shared with the DTO and the
    // service guard via TransitionReasonRequired.
    if (!TransitionReasonRequired.has(values.decision)) return;
    if ((values.reason ?? '').trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A reason is required when rejecting a booking',
      });
    }
  });

type ApprovalFormValues = z.infer<typeof approvalSchema>;

/**
 * Currency for display. The API returns decimal STRINGS ("4200000.00"), so a
 * value is converted before formatting, and anything not finite is passed
 * through rather than rendered as "NaN". Same wrapper the grid and detail page
 * use.
 */
function formatMoney(value: string | undefined | null): string {
  if (value === undefined || value === null) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

/** Minimal booking shape the dialog needs (from the grid row). */
export type BookingApprovalTarget = {
  id: string;
  leadName?: string;
  unitNumber?: string;
  amount?: string;
  tokenAmount?: string | null;
  status?: string;
};

export type BookingApprovalDialogProps = {
  booking: BookingApprovalTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecided?: () => void;
};

/**
 * Pure form-body markup, exported for tests (jsdom portal rule). Receives the
 * Dialog's single `form` instance - it does not create its own.
 *
 * T-APPROVE-ONE-CONTROL: this body is only the REASON field now. The decision is
 * made by the footer's Approve/Reject buttons, which are the dialog's single
 * answer to "what happens if I continue". The reason field's label tracks the
 * pending decision so it still reads correctly before anything is clicked.
 */
export function BookingApprovalFormBody({
  form,
  onSubmit,
}: {
  form: UseFormReturn<ApprovalFormValues>;
  onSubmit: (values: ApprovalFormValues) => void;
}) {
  // The reason is only required for a rejection, so it is NOT marked
  // `required: true` (that would set the HTML `required` attribute and block
  // an approval). The superRefine above enforces the conditional rule.
  const decision = form.watch('decision');

  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      // The decision buttons live in the Dialog footer (linked via
      // form={FORM_ID}); hide the Form's own actions so submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={[
        {
          type: 'textarea',
          name: 'reason',
          label: decision === 'REJECTED' ? 'Reason' : 'Reason (optional)',
          description:
            decision === 'REJECTED'
              ? 'Required. Recorded in the audit log and sent to the booking owner.'
              : 'Optional note for the audit trail. Required if you reject.',
          placeholder: 'e.g. customer backed out, payment not received',
          textareaProps: {
            rows: 3,
            maxLength: 500,
            'data-qa': 'booking-approval-reason',
          },
        },
      ]}
    />
  );
}

/**
 * Controlled approval dialog. `booking === null` renders nothing (the page
 * holds the target row in state; null = closed). Owns the form + the mutation.
 */
export function BookingApprovalDialog({
  booking,
  open,
  onOpenChange,
  onDecided,
}: BookingApprovalDialogProps) {
  const updateBooking = useUpdateBooking();
  const pending = updateBooking.isPending;

  const form = useForm<ApprovalFormValues>({
    resolver: zodResolver(approvalSchema),
    defaultValues: { decision: 'APPROVED', reason: '' },
    mode: 'onSubmit',
  });

  // Reset when a different booking opens - a stale decision or reason must
  // never leak into the next approval.
  useEffect(() => {
    if (open && booking !== null) {
      form.reset({ decision: 'APPROVED', reason: '' });
    }
  }, [open, booking?.id]);

  if (booking === null) return null;
  const target = booking;

  function submit(values: ApprovalFormValues) {
    const reason = (values.reason ?? '').trim();
    const body: { toStatus: BookingStatus; reason?: string } = {
      toStatus: values.decision,
    };
    if (reason.length > 0) body.reason = reason;

    updateBooking.mutate(
      { id: target.id, body },
      {
        onSuccess: () => {
          toast.success(`Booking moved to ${labelFor('booking', values.decision)}`);
          onOpenChange(false);
          onDecided?.();
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      }
    );
  }

  function decide(decision: 'APPROVED' | 'REJECTED') {
    form.setValue('decision', decision);
    // handleSubmit runs the resolver against the freshly-set value, so the
    // rejection reason rule is applied before the mutation fires.
    void form.handleSubmit(submit)();
  }

  const detail =
    typeof target.leadName === 'string' && target.leadName.length > 0
      ? target.leadName
      : 'this booking';
  const unitNumber =
    typeof target.unitNumber === 'string' && target.unitNumber.length > 0
      ? target.unitNumber
      : null;

  // T-APPROVE-TOKEN-AMOUNT (2026-09-16, owner report): the dialog declared
  // `amount` and `tokenAmount` on its target type but rendered neither, so the
  // manager was asked to approve a booking without seeing the money. The TOKEN
  // is the part that has actually been received - the number this decision is
  // about - so it leads; the total is secondary context.
  const tokenNum = Number(target.tokenAmount);
  const hasToken =
    typeof target.tokenAmount === 'string' &&
    target.tokenAmount.length > 0 &&
    Number.isFinite(tokenNum) &&
    tokenNum !== 0;
  const moneyLine = hasToken
    ? `Token received: ${formatMoney(target.tokenAmount)} of ${formatMoney(target.amount)}`
    : typeof target.amount === 'string' && target.amount.length > 0
      ? `Total: ${formatMoney(target.amount)} · no token recorded`
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-md"
      header={{
        title: `Approve booking for ${detail}`,
        description: (
          <>
            {unitNumber === null
              ? 'Unit not set - awaiting a manager decision.'
              : `Unit ${unitNumber} - awaiting a manager decision.`}
            {moneyLine === null ? null : (
              <span className="mt-1 block tabular-nums" data-qa="booking-approval-money">
                {moneyLine}
              </span>
            )}
          </>
        ),
      }}
      footer={
        // T-APPROVE-ONE-CONTROL: this footer is the dialog's ONLY decision
        // control (the body's Decision select was removed - two controls for one
        // choice made the user ask which one counted). Order is
        // Cancel / Reject / Approve so the primary action sits last, and Reject is
        // styled as destructive so "no" cannot be mistaken for "yes" in a hurry.
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="booking-approval-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            isLoading={pending && form.getValues('decision') === 'REJECTED'}
            loadingText="Rejecting..."
            onClick={() => decide('REJECTED')}
            data-qa="booking-approval-reject"
          >
            Reject booking
          </Button>
          <Button
            type="button"
            isLoading={pending && form.getValues('decision') === 'APPROVED'}
            loadingText="Approving..."
            onClick={() => decide('APPROVED')}
            data-qa="booking-approval-approve"
          >
            Approve booking
          </Button>
        </div>
      }
    >
      <BookingApprovalFormBody form={form} onSubmit={submit} />
    </Dialog>
  );
}
