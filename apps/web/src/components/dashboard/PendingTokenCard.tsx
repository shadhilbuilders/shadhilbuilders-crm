'use client';

// PendingTokenCard - bookings on HOLD that need their token payment recorded
// (T-HOLD-VISIBLE, 2026-09-16).
//
// WHY THIS CARD EXISTS. Fixing the approvals card (it had queried HOLD while the
// dialog only acts on TOKEN) left HOLD bookings with NO dashboard surface at all:
// a booking that has been initiated but has no token payment was simply not
// visible to anyone on the dashboard. It is real work - the unit is held, money
// is outstanding, and the deal cannot advance until the token is recorded - so
// it needs a place in the queue.
//
// WHY IT IS A SEPARATE CARD AND NOT ROWS IN "AWAITING APPROVAL":
// HOLD -> TOKEN is a DIFFERENT ACTION with a DIFFERENT ROLE GATE.
// - recording a token: MANAGER / SALES_EXEC / ADMIN / OWNER
// - a manager decision: MANAGER / ADMIN / OWNER
// A Sales Exec can record a token but can never approve. Merging the two would
// put rows in front of a manager that carry an action they do not need to take,
// and hide HOLD bookings from the exec who actually has to chase the payment.
// The server enforces both gates (BookingsService.transition), and
// `canInitiateBookings` mirrors the token one, so the card is only rendered for
// roles the API would accept.
//
// WHY THERE IS NO DIALOG HERE (the approvals card DOES use one):
// Recording a token is a single forward step with no decision in it - there is
// nothing to review, and the transition requires no reason
// (`TransitionReasonRequired` is CANCELLED/REJECTED only). A confirmation modal
// would be friction with no information in it. The one thing it must not do is
// fire by accident while scrolling, so the button names BOTH the verb and the
// unit ("Record token for D-102"), and the dialog is reserved for the action
// that genuinely needs a confirmation step - a decision with money on it.
//
// The card never calls the API itself: it owns no mutation. The page passes
// `onRecord` and `busyBookingId`, because the mutation hook is a useMutation and
// calling one per row would make the hook count vary with the row count (see the
// QueueItem note in page.tsx).

import { Button } from '@paalstack/react-ui';

import { SectionCard } from '@/components/dashboard/dashboard-shared';
import { currencyIntl } from '@/lib/format';

/**
 * Currency for display. The API returns the amount as a decimal STRING
 * ("4200000.00"), so it is converted before formatting - and a value that is
 * not a finite number is passed through unchanged rather than rendered as
 * "NaN". Same shape as the wrapper the approvals card and bookings grid use.
 */
function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

/** The fields this card reads off a booking list row. */
type BookingListRow = {
  id: string;
  leadName?: string;
  amount?: string;
  tokenAmount?: string;
  /** The villa/unit number - a booking's primary identifier. */
  unitNumber?: string;
};

export function PendingTokenCard({
  bookings,
  isLoading,
  busyBookingId,
  onRecord,
}: {
  bookings: unknown[];
  isLoading: boolean;
  /** The booking currently being moved, so only ITS button shows the spinner. */
  busyBookingId?: string | null;
  onRecord: (booking: { id: string; unitNumber?: string; leadName?: string }) => void;
}) {
  const rows = bookings as BookingListRow[];

  return (
    <SectionCard title="Needs token payment">
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">None waiting on a token.</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {rows.map((booking) => {
            const unit =
              typeof booking.unitNumber === 'string' && booking.unitNumber.length > 0
                ? booking.unitNumber
                : null;
            const leadName = booking.leadName ?? booking.id;
            // Unit first: for a booking the NUMBER identifies it (which villa),
            // the customer name is secondary - same ordering as the approvals
            // card and the bookings grid.
            const label = unit === null ? leadName : `Unit ${unit} · ${leadName}`;
            const busy = busyBookingId === booking.id;
            return (
              <li
                key={booking.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="text-muted-foreground tabular-nums">{formatMoney(booking.amount)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  isLoading={busy}
                  loadingText="Recording..."
                  // T-DASH-MOBILE: 28px tall as `size="sm"`; 44px on a coarse
                  // pointer (see the approvals card for why `min-h-` not `h-`).
                  className="min-h-11 pointer-fine:min-h-0"
                  // The accessible name carries the unit, so a screen-reader user
                  // hearing a list of identical buttons knows which row each one
                  // moves - and cannot fire the wrong one.
                  aria-label={`Record token for ${label}`}
                  onClick={() =>
                    onRecord({
                      id: booking.id,
                      leadName: booking.leadName,
                      ...(unit === null ? {} : { unitNumber: unit }),
                    })
                  }
                  data-qa="booking-record-token"
                >
                  Record token
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
