'use client';

// PendingApprovalsCard - bookings on hold awaiting a manager decision
// (T-DASH-QUEUE, 2026-09-16).
//
// Extracted from the dashboard page for the same reason as TodayVisitsCard: the
// page had grown past a reviewable size, and this section is self-contained.
//
// VISIBILITY IS THE SERVER'S DECISION, mirrored on the client. The page only
// renders this card when `canApproveBookings(role)` is true (ADMIN / OWNER -
// MANAGER was revoked 2026-09-24), which mirrors the backend gate. A telecaller
// or manager never sees it, so the queue is not diluted with work that is not
// theirs.
//
// Approval is the one action on the dashboard that genuinely needs a dialog: it
// has an amount, a reason, and consequences. Rather than flatten it into a
// queue-row button, the row opens the real BookingApprovalDialog so the
// approver gets the same confirmation surface the bookings page gives them. This
// is the deliberate exception to "actions live on the row" - a decision with
// money on it deserves a confirmation step.

import { Button } from '@paalstack/react-ui';

import { SectionCard } from '@/components/dashboard/dashboard-shared';
import { Skeleton } from '@/components/shared/Skeleton';
import { currencyIntl } from '@/lib/format';

/**
 * Currency for display. The API returns the amount as a decimal STRING
 * ("4200000.00"), so it is converted before formatting - and a value that is not
 * a finite number is passed through unchanged rather than rendered as "NaN".
 * Same shape as the wrapper the bookings grid and detail page use.
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
  /** T-APPROVE-UNIT-NAME (2026-09-16): the booking's villa/unit number. The
   *  backend list already returns it; the card simply was not showing it. */
  unitNumber?: string;
  /** T-APPROVE-TOKEN-AMOUNT (2026-09-16, owner report): the token payment the
   *  manager is being asked to approve against. Also already on the list row
   *  (`BookingRow.tokenAmount`, selected by BookingsService.list) - it was just
   *  not being rendered, so the manager decided without seeing the money that
   *  had actually come in. */
  tokenAmount?: string | null;
};

export function PendingApprovalsCard({
  bookings,
  isLoading,
  onReview,
}: {
  bookings: unknown[];
  isLoading: boolean;
  onReview: (booking: {
    id: string;
    leadName?: string;
    amount?: string;
    unitNumber?: string;
    tokenAmount?: string | null;
  }) => void;
}) {
  const rows = bookings as BookingListRow[];

  return (
    <SectionCard title="Awaiting approval">
      {isLoading ? (
        <Skeleton variant="table" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No bookings on hold.</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {rows.map((booking) => {
            const unit =
              typeof booking.unitNumber === 'string' && booking.unitNumber.length > 0
                ? booking.unitNumber
                : null;
            const leadName = booking.leadName ?? booking.id;
            // The unit leads: for a booking, the NUMBER is the primary
            // identifier (which villa), the customer name is secondary. Same
            // ordering the bookings grid and the CRM use.
            const label = unit === null ? leadName : `Unit ${unit} · ${leadName}`;
            // A token of 0 is treated as "no token recorded" - the column is
            // nullable, and "Token received: ₹0.00" would be misleading on a
            // booking that simply has not paid one yet.
            const tokenNum = Number(booking.tokenAmount);
            const tokenReceived =
              booking.tokenAmount === null ||
              booking.tokenAmount === undefined ||
              !Number.isFinite(tokenNum) ||
              tokenNum === 0
                ? null
                : formatMoney(booking.tokenAmount);
            return (
              <li
                key={booking.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatMoney(booking.amount)}
                </span>
                {/*
                  The token payment, labelled. An unlabelled second figure beside
                  the total would read as an amount owed rather than money
                  received - and this is the number the approval is FOR. Rendered
                  only when a token was actually recorded: a booking with no token
                  must not show a misleading "₹0.00".
                */}
                {tokenReceived === null ? null : (
                  <span
                    className="text-muted-foreground text-xs tabular-nums"
                    data-qa="booking-approval-token-amount"
                  >
                    Token received: {tokenReceived}
                  </span>
                )}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  // The variant already carries `underline-offset-4
                  // hover:underline`, so the underline shows on hover only and
                  // there is no second copy of it here to drift.
                  // `text-link` overrides the variant's `text-primary`: --link
                  // (the app's blue) is a DIFFERENT token from --primary (navy).
                  //
                  // T-DASH-MOBILE: a link-styled control is still a TAP TARGET.
                  // `size="sm"` renders 28px tall, so on a coarse pointer this
                  // gets the 44px minimum. `py-` rather than `min-h-` would
                  // still be 28px of hit area once the library's own height
                  // utility wins, hence `min-h-11` (a min-height beats a fixed
                  // height in the cascade when both are utilities of the same
                  // property, and the library sets `h-7`).
                  className="text-link inline-flex min-h-11 items-center px-2 pointer-fine:min-h-0 pointer-fine:px-0"
                  // The accessible name says WHICH booking, so a screen reader
                  // user hearing a list of "Review" buttons knows which is which.
                  // It carries the unit too, matching the visible row.
                  aria-label={`Review booking for ${label}`}
                  onClick={() =>
                    onReview({
                      id: booking.id,
                      leadName: booking.leadName,
                      amount: booking.amount,
                      tokenAmount: booking.tokenAmount,
                      ...(unit === null ? {} : { unitNumber: unit }),
                    })
                  }
                  data-qa="booking-approve-open"
                >
                  Review
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
