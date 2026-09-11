'use client';

// BookingEditDialog - edit a booking from the bookings list row actions.
//
// Editable surface (UpdateBookingDto): amount / tokenAmount / notes.
// leadId/unitId/status/userId/approvedById are NOT editable here:
//   - status changes go through the transition flow (PATCH /bookings/:id)
//   - unit/lead reassignment is out of scope for v1
//
// ONE form instance: the Dialog owns the single `useForm` (it needs
// `form.reset` on open + `handleSubmit`). `BookingEditFormBody` is a pure
// presentational component that receives the `form` as a prop - it's
// exported separately so tests can render the fields without the Dialog
// portal (Base UI portals render empty under renderToStaticMarkup).
//
// Form is the props-API Form (data-driven `fields`); numeric fields are
// kept as strings in the form and converted in onSubmit (the codebase
// pattern - avoids the z.coerce type issue).
import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import { useForm, type UseFormReturn } from 'react-hook-form';

import { useEditBooking } from '@/hooks/queries/crm';

const FORM_ID = 'booking-edit-form';

// Client-side mirror of UpdateBookingDto (packages/api-types/src/bookings.ts).
// Numeric fields are kept as strings in the form and coerced on submit.
// The server re-validates with the canonical DTO.
const editBookingSchema = z.object({
  amount: z
    .string()
    .min(1, 'Amount is required')
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
      message: 'Amount must be a positive number',
    })
    .refine((v) => Number(v) <= 1_000_000_000, {
      message: 'Amount too large (cap ₹100 Cr)',
    }),
  tokenAmount: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === '' || (Number.isFinite(Number(v)) && Number(v) > 0),
      { message: 'Token amount must be a positive number' },
    ),
  notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
});

type EditBookingSchema = z.infer<typeof editBookingSchema>;

/** Minimal booking shape the dialog needs (from the grid row). */
export type BookingEditTarget = {
  id: string;
  leadName?: string;
  amount?: string;
  tokenAmount?: string | null;
  notes?: string | null;
};

export type BookingEditDialogProps = {
  booking: BookingEditTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
};

/**
 * Pure form-body markup, exported for tests (jsdom portal rule: render THIS
 * with renderToStaticMarkup; the Dialog shell + footer are covered by the
 * parent's render flow). Receives the single `form` instance owned by the
 * Dialog - it does NOT create its own.
 */
export function BookingEditFormBody({
  form,
  onSubmit,
}: {
  form: UseFormReturn<EditBookingSchema>;
  onSubmit: (values: EditBookingSchema) => void;
}) {
  return (
    <Form
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      // The Save action lives in the Dialog footer (linked via
      // form={FORM_ID} + type="submit" on the footer button); hide the
      // Form's own action buttons so the submit isn't duplicated.
      hideSubmitButton
      hideResetButton
      fields={[
        {
          type: 'input',
          name: 'amount',
          label: 'Total amount (₹)',
          required: true,
          inputType: 'number',
          description: 'Booking value in rupees (cap ₹100 Cr).',
          inputProps: {
            min: 1,
            step: 1,
            'data-qa': 'booking-edit-amount',
          },
        },
        {
          type: 'input',
          name: 'tokenAmount',
          label: 'Token amount (₹, optional)',
          inputType: 'number',
          description: 'Leave blank to clear the token amount.',
          inputProps: {
            min: 0,
            step: 1,
            'data-qa': 'booking-edit-token-amount',
          },
        },
        {
          type: 'textarea',
          name: 'notes',
          label: 'Notes',
          textareaProps: { rows: 3, maxLength: 2000, 'data-qa': 'booking-edit-notes' },
        },
      ]}
    />
  );
}

/**
 * Controlled edit dialog. `booking === null` renders nothing (the grid
 * holds the currently-editing row in state; null = closed). Owns the
 * single `useForm` instance.
 */
export function BookingEditDialog({
  booking,
  open,
  onOpenChange,
  onSaved,
}: BookingEditDialogProps) {
  const editBooking = useEditBooking();
  const pending = editBooking.isPending;

  const form = useForm<EditBookingSchema>({
    resolver: zodResolver(editBookingSchema),
    defaultValues: {
      amount: booking?.amount ?? '',
      tokenAmount: booking?.tokenAmount ?? '',
      notes: booking?.notes ?? '',
    },
    mode: 'onSubmit',
  });

  // Reset RHF defaults when a different booking opens - stale values from
  // a previous edit must never leak into the next dialog.
  useEffect(() => {
    if (open && booking !== null) {
      form.reset({
        amount: booking.amount ?? '',
        tokenAmount: booking.tokenAmount ?? '',
        notes: booking.notes ?? '',
      });
    }
  }, [open, booking?.id]);

  if (booking === null) return null;
  const target = booking;

  function handleSubmit(values: EditBookingSchema) {
    // zodResolver already validated amount/tokenAmount.
    const amount = Number(values.amount);
    let tokenAmount: number | null | undefined;
    if (values.tokenAmount !== undefined && values.tokenAmount.trim().length > 0) {
      tokenAmount = Number(values.tokenAmount);
    } else {
      // Blank token amount clears it (nullable in the DTO).
      tokenAmount = null;
    }

    const payload: {
      amount: number;
      tokenAmount?: number | null;
      notes?: string | null;
    } = { amount, tokenAmount };
    if (values.notes !== undefined && values.notes.trim().length > 0) {
      payload.notes = values.notes.trim();
    } else {
      payload.notes = null;
    }

    editBooking.mutate(
      { id: target.id, body: payload },
      {
        onSuccess: () => {
          toast.success('Booking updated');
          onOpenChange(false);
          onSaved?.();
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      header={{
        title: `Edit booking${target.leadName ? ` for ${target.leadName}` : ''}`,
        description: 'Update the booking amount, token amount, or notes.',
      }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            data-qa="booking-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={pending}
            loadingText="Saving..."
            data-qa="booking-edit-save"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <BookingEditFormBody form={form} onSubmit={handleSubmit} />
    </Dialog>
  );
}
