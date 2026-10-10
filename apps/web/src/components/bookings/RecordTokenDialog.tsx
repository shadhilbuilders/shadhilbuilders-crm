'use client';

// RecordTokenDialog - the UI path for HOLD -> TOKEN on the work dashboard.
//
// WHY THIS EXISTS (T-TOKEN-GATE, 2026-09-28). `PendingTokenCard` used to have no
// dialog at all, deliberately: recording a token was documented as "a single
// forward step with no decision in it - there is nothing to review, and the
// transition requires no reason". That reasoning held only while the transition
// recorded NO AMOUNT. It set `status = 'TOKEN'` and never touched
// `tokenAmount`, so a booking could be marked token-received with the amount
// left NULL - unverifiable on its own, and actively misread downstream: the
// admin "Booking money" card derives its meaning from that column, so a NULL
// token renders as "no token", i.e. money still with the customer, for a booking
// the operator just marked as paid.
//
// Now that the amount is REQUIRED, the dashboard needs somewhere to enter it -
// and that makes the action a form, not a one-click button. The card keeps
// opening on a row, but the row opens this dialog, exactly as the approvals card
// opens BookingApprovalDialog. Same shape on purpose: a dashboard row that
// changes money should ask for the money the same way wherever it appears.
//
// It also PREFILLS from `booking.tokenAmount` when one is already recorded
// (captured at HOLD time - `CreateBookingDto` accepts it), so re-recording or
// correcting cannot silently blank a value that already exists.
//
// Two-API convention (as BookingApprovalDialog): the Dialog shell owns the single
// `useForm`; the body is a separate named export so tests can render it without
// the Base UI portal (portals render empty under renderToStaticMarkup).
import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';

import {
  isTokenWithinTotal,
  TOKEN_EXCEEDS_TOTAL_MESSAGE,
  TokenAmountSchema,
} from '@shadhil/api-types';
import { useUpdateBooking } from '@/hooks/queries/crm';
import { currencyIntl } from '@/lib/format';

const FORM_ID = 'booking-record-token-form';

/** Same wording as BookingTransitionDto / booking detail transition form. */
export const TOKEN_AMOUNT_REQUIRED_MESSAGE =
  'Enter the token amount received before marking the token as received';

/**
 * Client-side form for a move into TOKEN: the amount received is required.
 *
 * `TokenAmountSchema` is IMPORTED, not restated - the positive/positive-cap rule
 * has one home in @shadhil/api-types. It is also a NUMBER, because that is what
 * the `@paalstack/react-ui` number field writes into the form
 * (`event.currentTarget.valueAsNumber`; `undefined` when blank). Declaring it
 * `z.string()` here is what produced "Invalid input: expected string, received
 * number" on every submit.
 *
 * Blank stays `undefined` on the field (`.optional()`), and the required rule
 * lives in `superRefine` so the Form can attach a field-level message - the Form
 * ships with `noValidate`, so HTML `required` never surfaces an error.
 */
export const recordTokenSchemaFor = (totalAmount: number) =>
  z
    .object({
      tokenAmount: TokenAmountSchema.optional(),
    })
    .superRefine((values, ctx) => {
      if (values.tokenAmount === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokenAmount'],
          message: TOKEN_AMOUNT_REQUIRED_MESSAGE,
        });
        return;
      }
      // T-TOKEN-GATE cap (owner instruction): a token is a PART payment, so it can
      // never exceed the booking's total. The dialog knows the total, so it says so
      // before the request; the service re-checks it authoritatively.
      if (!isTokenWithinTotal(values.tokenAmount, totalAmount)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokenAmount'],
          message: TOKEN_EXCEEDS_TOTAL_MESSAGE,
        });
      }
    });

export type RecordTokenFormValues = { tokenAmount?: number };

/** The booking row the dialog acts on. */
export type RecordTokenTarget = {
  id: string;
  leadName?: string;
  amount?: string;
  unitNumber?: string;
  /** Already-recorded token, prefilled so the value cannot be lost. */
  tokenAmount?: string | null;
};

/**
 * Currency for display; the API returns decimal STRINGS ("4200000.00").
 * A non-finite value is passed through unchanged rather than shown as "NaN".
 */
function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

/** The unit leads: for a booking the NUMBER identifies it, the name is secondary. */
export function bookingLabel(target: {
  leadName?: string;
  unitNumber?: string;
  id: string;
}): string {
  const unit =
    typeof target.unitNumber === 'string' && target.unitNumber.length > 0
      ? target.unitNumber
      : null;
  const leadName = target.leadName ?? target.id;
  return unit === null ? leadName : `Unit ${unit} · ${leadName}`;
}

/**
 * Pure form-body markup, exported for tests (jsdom portal rule). Receives the
 * Dialog's single `form` instance - it does not create its own.
 */
export function RecordTokenFormBody({
  form,
  onSubmit,
}: {
  form: UseFormReturn<RecordTokenFormValues>;
  onSubmit: (values: RecordTokenFormValues) => void;
}) {
  // Repo convention (leads/new, settings, admin/users): a TYPED locals array.
  // The annotation also matters for correctness - an inline literal would widen
  // `type` to `string` and the Form's discriminated union would reject it.
  const fields: FormFieldItemType<RecordTokenFormValues>[] = [
    {
      type: 'number',
      name: 'tokenAmount',
      label: 'Token amount received',
      required: true,
      description: 'The amount actually received. Recorded with the status change.',
      placeholder: 'e.g. 500000',
      // The library's own guard: the control is free-text, so this keeps a
      // negative or a stray "-" out before zod ever sees it.
      numberInputProps: { isPositiveFloat: true, 'data-qa': 'record-token-amount' },
    },
  ];

  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      // The confirm button lives in the Dialog footer (linked via form={FORM_ID});
      // hide the Form's own actions so submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}

export function RecordTokenDialog({
  booking,
  onOpenChange,
  onRecorded,
}: {
  booking: RecordTokenTarget | null;
  onOpenChange: (open: boolean) => void;
  onRecorded?: () => void;
}) {
  const updateBooking = useUpdateBooking();
  const pending = updateBooking.isPending;

  // The cap needs the booking total, so the schema is built per booking. A
  // non-finite total falls back to 0, which rejects any token - the safe
  // direction.
  const totalRaw = Number(booking?.amount);
  const bookingTotal = Number.isFinite(totalRaw) ? totalRaw : 0;

  const form = useForm<RecordTokenFormValues>({
    resolver: zodResolver(recordTokenSchemaFor(bookingTotal)),
    defaultValues: { tokenAmount: undefined },
    mode: 'onSubmit',
  });

  // Reset when a different booking opens - a stale amount from the previous row
  // must never leak into this one, which is how a booking could be marked with
  // someone else's token figure.
  useEffect(() => {
    if (booking === null) return;
    // The booking row carries decimals as STRINGS ("500000.00"); the field is
    // numeric, so convert - and treat non-positive/absent as "nothing recorded".
    const stored = Number(booking.tokenAmount);
    form.reset({
      tokenAmount:
        typeof booking.tokenAmount === 'string' &&
        booking.tokenAmount.length > 0 &&
        Number.isFinite(stored) &&
        stored > 0
          ? stored
          : undefined,
    });
  }, [booking?.id, booking?.tokenAmount]);

  if (booking === null) return null;
  const target = booking;
  const label = bookingLabel(target);

  function submit(values: RecordTokenFormValues) {
    // Already a number (the field writes `valueAsNumber`) and already validated
    // positive by the shared schema.
    const tokenAmount = values.tokenAmount;
    if (tokenAmount === undefined) return;

    updateBooking.mutate(
      // The amount travels WITH the status change, in one request, so "token
      // received" and "how much" can never be recorded separately.
      { id: target.id, body: { toStatus: 'TOKEN', tokenAmount } },
      {
        onSuccess: () => {
          toast.success(`Token recorded for ${label}`);
          onOpenChange(false);
          onRecorded?.();
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : 'Could not record the token'),
      },
    );
  }

  // The token (or its absence) is the money this dialog is about, so it leads;
  // the booking total is secondary context.
  const tokenNum = Number(target.tokenAmount);
  const hasToken =
    typeof target.tokenAmount === 'string' &&
    target.tokenAmount.length > 0 &&
    Number.isFinite(tokenNum) &&
    tokenNum !== 0;
  const moneyLine = hasToken
    ? `Already recorded: ${formatMoney(target.tokenAmount ?? undefined)} of ${formatMoney(target.amount)}`
    : typeof target.amount === 'string' && target.amount.length > 0
      ? `Booking ${formatMoney(target.amount)} · no token recorded yet`
      : null;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-lg"
      header={{
        title: `Record token for ${label}`,
        description:
          moneyLine === null ? (
            'Enter the amount actually received.'
          ) : (
            <span className="tabular-nums" data-qa="record-token-money">
              {moneyLine}
            </span>
          ),
      }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="record-token-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Recording..."
            data-qa="record-token-confirm"
          >
            Record token
          </Button>
        </div>
      }
    >
      <RecordTokenFormBody form={form} onSubmit={submit} />
    </Dialog>
  );
}
