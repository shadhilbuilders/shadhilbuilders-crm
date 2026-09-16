// BookingTransitionConfirmStep - the confirm step of a booking status change.
//
// Extracted from the booking detail PAGE for two reasons:
//   1. Next.js forbids extra named exports from a `page.tsx` (its generated
//      type-check requires the module's exports to be only the page contract),
//      so a test-visible block cannot live there.
//   2. The layout ORDER of this block is the feature: "Move from X to Y" must
//      come BEFORE the reason textarea (user direction, 2026-09-15) so the
//      operator reads which move they are confirming before being asked to
//      justify it. A static render of the page only ever shows step 1, so the
//      order is only assertable if this block is renderable on its own.
//
// Presentational: it receives the parent's single `useForm` instance (the
// props-API `Form` does not create its own) and never owns form state. Same
// convention as UnitEditFormBody / BookingApprovalFormBody.
import type { ComponentType } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Button, Form } from '@paalstack/react-ui';
import type { BookingStatus } from '@shadhil/api-types';

import { labelFor } from '@/lib/labels';

export const TRANSITION_FORM_ID = 'booking-transition-form';

/** The statuses a booking can be MOVED INTO (HOLD is start-only). */
export type BookingTransitionTarget = Exclude<BookingStatus, 'HOLD'>;

export type TransitionFormValues = {
  toStatus: BookingTransitionTarget;
  reason?: string;
};

/** Row-badge colours, mirrored from the page so this block stays presentational. */
const STATUS_BADGE_CLASS: Record<string, string> = {
  HOLD: 'bg-amber-100 text-amber-900',
  TOKEN: 'bg-blue-100 text-blue-900',
  APPROVED: 'bg-green-100 text-green-900',
  REJECTED: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

export function BookingTransitionConfirmStep({
  form,
  onSubmit,
  currentStatus,
  toStatus,
  reasonRequired,
  isPending,
  ConfirmIcon,
  onCancelStep,
}: {
  form: UseFormReturn<TransitionFormValues>;
  onSubmit: (values: TransitionFormValues) => void;
  currentStatus: string;
  toStatus: BookingTransitionTarget;
  reasonRequired: boolean;
  isPending: boolean;
  ConfirmIcon?: ComponentType<{ className?: string }>;
  onCancelStep: () => void;
}) {
  return (
    <div className="space-y-4" data-qa="booking-transition-step">
      {/* Context FIRST, input SECOND. Do not reorder: the operator should read
          which move they are confirming before being asked to justify it. */}
      <div className="flex items-center gap-2 text-sm" data-qa="booking-transition-context">
        Move from{' '}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_BADGE_CLASS[currentStatus] ?? 'bg-gray-100 text-gray-700'
          }`}
        >
          {labelFor('booking', currentStatus)}
        </span>{' '}
        to{' '}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_BADGE_CLASS[toStatus]
          }`}
        >
          {labelFor('booking', toStatus)}
        </span>
      </div>

      <Form
        id={TRANSITION_FORM_ID}
        form={form}
        onSubmit={onSubmit}
        // The confirm action renders below so it can carry the transition icon;
        // hide the Form's own buttons so the submit isn't duplicated.
        hideSubmitButton
        hideResetButton
        fields={[
          {
            type: 'textarea',
            name: 'reason',
            label: reasonRequired ? 'Reason' : 'Reason (optional)',
            required: reasonRequired,
            description: reasonRequired
              ? 'Required. Recorded in the audit log and sent to the booking owner.'
              : 'Optional note for the audit trail.',
            placeholder: 'e.g. customer backed out, payment not received',
            textareaProps: {
              rows: 2,
              maxLength: 500,
              'data-qa': 'booking-reason',
            },
          },
        ]}
      />

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancelStep}
          data-qa="booking-transition-cancel"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          form={TRANSITION_FORM_ID}
          size="sm"
          disabled={isPending}
          data-qa="booking-confirm"
          className="gap-1.5"
        >
          {isPending ? (
            'Saving...'
          ) : (
            <>
              {ConfirmIcon ? <ConfirmIcon className="h-4 w-4" aria-hidden="true" /> : null}
              {toStatus === 'APPROVED'
                ? 'Confirm approval'
                : `Confirm ${labelFor('booking', toStatus)}`}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
