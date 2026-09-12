'use client';

// /bookings/[id] - Booking detail + approval surface (T-BOOK).
//
// The bookings list page deep-links here for MANAGER/ADMIN to review a
// TOKEN booking ("Review approval →"). This page:
//   - Fetches the single booking via GET /bookings/:id (useBooking).
//   - Shows the full row (lead, unit, amounts, owner, approval, dates).
//   - Lets the actor advance the state via PATCH /bookings/:id
//     (useUpdateBooking), gated by the same legalNextStates() table the
//     backend enforces (mirrored locally so the UI only offers legal
//     moves; the server re-validates and rejects illegal ones).
//
// Approval gating: transitioning to APPROVED is MANAGER/ADMIN only
// (backend enforces; the UI hides the button for other roles via
// canApproveBookings). REJECTED/CANCELLED require a reason (audit
// policy) - the form prompts for it inline, mirroring LeadActionPanel.
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Textarea, toast } from '@paalstack/react-ui';
import { LuArrowRight } from '@paalstack/react-icons/lu';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import { useBooking, useUpdateBooking } from '@/hooks/queries/crm';
import { currencyIntl, dateIntl } from '@/lib/format';
import { labelFor, type BookingStatus } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { canApproveBookings, useSessionUser } from '@/lib/session';

type BookingRow = {
  id: string;
  leadId?: string;
  leadName?: string;
  unitId?: string;
  userName?: string;
  amount?: string;
  tokenAmount?: string | null;
  status?: string;
  approvedByName?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

// Local mirror of the backend legalNextStates() (bookings.service.ts).
// The UI only offers legal moves; the server re-validates and rejects
// anything else with a 400.
const LEGAL_NEXT: Record<BookingStatus, BookingStatus[]> = {
  HOLD: ['TOKEN', 'CANCELLED'],
  TOKEN: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
};

const STATUS_BADGE_CLASS: Record<BookingStatus, string> = {
  HOLD: 'bg-amber-100 text-amber-900',
  TOKEN: 'bg-blue-100 text-blue-900',
  APPROVED: 'bg-green-100 text-green-900',
  REJECTED: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

function isBookingStatus(value: string): value is BookingStatus {
  return (['HOLD', 'TOKEN', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).includes(
    value as BookingStatus,
  );
}

function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const bookingId = typeof params?.id === 'string' ? params.id : null;
  // T-ProjectSwitch: slugs key hrefs (id keyed API hooks use the booking id).
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  const bookingQuery = useBooking(bookingId);
  const { user } = useSessionUser();
  const canApprove = canApproveBookings(user?.role);

  const booking = bookingQuery.data as BookingRow | undefined;
  const leadName =
    typeof booking?.leadName === 'string' && booking.leadName.length > 0
      ? booking.leadName
      : 'Booking';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Bookings', href: projectHref(orgSlug, projectSlug, '/bookings') },
          { label: leadName },
        ]}
      />

      {bookingQuery.isLoading ? (
        <div className="space-y-4">
          <Skeleton variant="card" />
          <Skeleton variant="list" count={3} />
        </div>
      ) : booking !== undefined && booking !== null ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <BookingInfoCard booking={booking} />
          <BookingActions
            booking={booking}
            canApprove={canApprove}
            orgSlug={orgSlug}
            projectSlug={projectSlug}
          />
        </div>
      ) : (
        <ModulePending
          title="Booking detail"
          description="Booking lifecycle with manager approval gating."
          error={bookingQuery.error}
          isLoading={bookingQuery.isLoading}
        />
      )}
    </div>
  );
}

function BookingInfoCard({ booking }: { booking: BookingRow }) {
  const status = typeof booking.status === 'string' ? booking.status : '';
  const badgeClass = isBookingStatus(status)
    ? STATUS_BADGE_CLASS[status]
    : 'bg-gray-100 text-gray-700';

  const meta: Array<{ label: string; value: string | null }> = [
    { label: 'Lead', value: booking.leadName ?? null },
    { label: 'Owner', value: booking.userName ?? null },
    { label: 'Approved by', value: booking.approvedByName ?? null },
    { label: 'Total amount', value: formatMoney(booking.amount) },
    { label: 'Token amount', value: formatMoney(booking.tokenAmount ?? undefined) },
  ];

  return (
    <Card data-qa="booking-info-card">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-xl">{booking.leadName ?? 'Booking'}</CardTitle>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}
            data-qa="booking-status-badge"
          >
            {isBookingStatus(status) ? labelFor('booking', status) : status || '-'}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {meta.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {row.label}
              </dt>
              <dd className="text-sm">{row.value ?? '-'}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Created
            </dt>
            <dd className="text-sm">
              {typeof booking.createdAt === 'string'
                ? dateIntl.formatDateTime(booking.createdAt)
                : '-'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Updated
            </dt>
            <dd className="text-sm">
              {typeof booking.updatedAt === 'string'
                ? dateIntl.formatDateTime(booking.updatedAt)
                : '-'}
            </dd>
          </div>
        </dl>
        {typeof booking.notes === 'string' && booking.notes.length > 0 ? (
          <div className="border-border border-t pt-3">
            <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Notes
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{booking.notes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BookingActions({
  booking,
  canApprove,
  orgSlug,
  projectSlug,
}: {
  booking: BookingRow;
  canApprove: boolean;
  orgSlug: string | null;
  projectSlug: string | null;
}) {
  const router = useRouter();
  const updateBooking = useUpdateBooking();
  const [toStatus, setToStatus] = useState<BookingStatus | null>(null);
  const [reason, setReason] = useState('');

  const status = typeof booking.status === 'string' ? booking.status : '';
  const current = isBookingStatus(status) ? status : null;
  const outgoing = current !== null ? LEGAL_NEXT[current] : [];

  // APPROVED is only offered to MANAGER/ADMIN (backend enforces too).
  const offered = outgoing.filter(
    (s) => s !== 'APPROVED' || canApprove,
  );

  if (current === null || offered.length === 0) {
    return (
      <Card data-qa="booking-actions">
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground text-xs">
            {current === null
              ? 'Unknown booking status.'
              : `No actions available from ${labelFor('booking', current)} (terminal state).`}
          </div>
        </CardContent>
      </Card>
    );
  }

  function onSubmit(target: BookingStatus) {
    const body: { toStatus: BookingStatus; reason?: string } = { toStatus: target };
    if (target === 'REJECTED' || target === 'CANCELLED') {
      const r = reason.trim();
      if (r.length === 0) {
        toast.error(`Reason is required when moving to ${labelFor('booking', target)}`);
        return;
      }
      body.reason = r;
    }
    updateBooking.mutate(
      { id: booking.id, body },
      {
        onSuccess: () => {
          toast.success(`Booking moved to ${labelFor('booking', target)}`);
          setToStatus(null);
          setReason('');
        },
        onError: (e) => {
          const msg = e instanceof Error ? e.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Card data-qa="booking-actions">
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {toStatus === null ? (
          <div className="flex flex-wrap gap-2">
            {offered.map((target) => (
              <Button
                key={target}
                type="button"
                size="sm"
                variant={target === 'APPROVED' ? 'default' : 'outline'}
                onClick={() => setToStatus(target)}
                data-qa={`booking-to-${target}`}
              >
                {target === 'APPROVED' ? 'Approve' : `→ ${labelFor('booking', target)}`}
              </Button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              Move from{' '}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  isBookingStatus(status) ? STATUS_BADGE_CLASS[status] : 'bg-gray-100 text-gray-700'
                }`}
              >
                {labelFor('booking', status)}
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

            {toStatus === 'REJECTED' || toStatus === 'CANCELLED' ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`reason-${booking.id}-${toStatus}`}>
                  Reason <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id={`reason-${booking.id}-${toStatus}`}
                  value={reason}
                  onChange={(e) => setReason(e.currentTarget.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="e.g. customer backed out, payment not received"
                  data-qa="booking-reason"
                />
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setToStatus(null);
                  setReason('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={updateBooking.isPending}
                onClick={() => onSubmit(toStatus)}
                data-qa="booking-confirm"
              >
                {updateBooking.isPending
                  ? 'Saving...'
                  : toStatus === 'APPROVED'
                    ? 'Confirm approval'
                    : (
                        <>
                          <LuArrowRight className="h-4 w-4" aria-hidden="true" />
                          Confirm {labelFor('booking', toStatus)}
                        </>
                      )}
              </Button>
            </div>
          </div>
        )}

        <div className="border-border border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void router.push(projectHref(orgSlug, projectSlug, '/bookings'))}
          >
            ← Back to bookings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
