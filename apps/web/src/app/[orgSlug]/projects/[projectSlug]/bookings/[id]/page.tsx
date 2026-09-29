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
import { useState, type ComponentType } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Card, CardContent, CardHeader, CardTitle, toast } from '@paalstack/react-ui';
import {
  LuArrowLeft,
  LuBadgeCheck,
  LuBan,
  LuCircleDollarSign,
  LuCircleX,
} from '@paalstack/react-icons/lu';
import {
  isTokenWithinTotal,
  TOKEN_EXCEEDS_TOTAL_MESSAGE,
  TokenAmountSchema,
  TransitionReasonRequired,
} from '@shadhil/api-types';

import { ModulePending } from '@/components/shared/ModulePending';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  BookingTransitionConfirmStep,
  type BookingTransitionTarget,
  type TransitionFormValues,
} from '@/components/bookings/BookingTransitionConfirmStep';
import { useBooking, useUpdateBooking } from '@/hooks/queries/crm';
import { currencyIntl, dateIntl } from '@/lib/format';
import { labelFor, type BookingStatus } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { canApproveBookings, canInitiateBookings, useSessionUser } from '@/lib/session';

type BookingRow = {
  id: string;
  leadId?: string;
  leadName?: string;
  unitId?: string;
  unitNumber?: string;
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
const LEGAL_NEXT: Record<BookingStatus, BookingTransitionTarget[]> = {
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

/**
 * A semantic icon per booking TRANSITION TARGET, used on the transition
 * buttons and the confirm action so an operator can scan the choices without
 * reading every label.
 *
 * Mirrors the `STATE_ICONS` convention in components/shared/LeadActionPanel.tsx:
 * one icon per target state, commented with why it reads the way it does.
 * Before this, every non-approval transition shared a single generic
 * `LuArrowRight`, so "Cancel booking" and "Token received" were visually
 * indistinguishable and the destructive one had no warning cue at all.
 *
 * Keyed on `BookingTransitionTarget`, so it covers exactly the states a button
 * can offer - `HOLD` is absent by construction (a booking is created in HOLD;
 * nothing transitions into it).
 */
const STATUS_ICONS: Readonly<
  Record<BookingTransitionTarget, ComponentType<{ className?: string }>>
> = {
  // Forward motions (money in, deal advances)
  TOKEN: LuCircleDollarSign, // token payment received
  APPROVED: LuBadgeCheck, // manager signed off, deal locked in
  // Rejection / release (the two that end or reverse a deal)
  REJECTED: LuCircleX, // manager refused this booking
  CANCELLED: LuBan, // cancelled - the destructive one, flagged
};

/** Icon shown on the "Back to bookings" action. */
const BACK_ICON = LuArrowLeft;

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
  // T-BOOK-ROLES: REJECTED is an approval decision (same gate as APPROVED).
  // TELECALLER must not be offered TOKEN either - the service 403s it now.
  const canInitiate = canInitiateBookings(user?.role);

  const booking = bookingQuery.data as BookingRow | undefined;
  const leadName =
    typeof booking?.leadName === 'string' && booking.leadName.length > 0
      ? booking.leadName
      : null;
  const unitNumber =
    typeof booking?.unitNumber === 'string' && booking.unitNumber.length > 0
      ? booking.unitNumber
      : null;

  // T-BOOK-LINK: the unit identifies a booking (one active booking per unit),
  // so it leads the crumb and the lead name is the parenthetical qualifier:
  // "A-101 (Priya Sharma)". Falls back sensibly when either side is missing.
  const crumbLabel =
    unitNumber !== null && leadName !== null
      ? `${unitNumber} (${leadName})`
      : (unitNumber ?? leadName ?? 'Booking');
  const pageTitle = unitNumber !== null ? `Unit ${unitNumber}` : 'Booking';

  return (
    <div className="space-y-4">
      <PageHeader
        title={pageTitle}
        breadcrumb={[
          { label: 'Work' },
          { label: 'Bookings', href: projectHref(orgSlug, projectSlug, '/bookings') },
          { label: crumbLabel },
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
            canInitiate={canInitiate}
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
    { label: 'Unit', value: booking.unitNumber ?? null },
    { label: 'Owner', value: booking.userName ?? null },
    { label: 'Approved by', value: booking.approvedByName ?? null },
    { label: 'Total amount', value: formatMoney(booking.amount) },
    { label: 'Token amount', value: formatMoney(booking.tokenAmount ?? undefined) },
  ];

  return (
    <Card data-qa="booking-info-card">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          {/* T-BOOK-LINK: unit-led title, matching the page header + crumb.
              The lead name has its own row in the detail list below. */}
          <CardTitle className="text-xl">
            {booking.unitNumber ? `Unit ${booking.unitNumber}` : (booking.leadName ?? 'Booking')}
          </CardTitle>
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

/**
 * Transition form schema (user direction: every input form goes through the
 * props-API `Form` + zod, not hand-rolled state).
 *
 * `toStatus` is a hidden piece of form state - the operator picks it with the
 * action buttons, and the confirm step renders it as a badge. `reason` is
 * required only for the moves that end or reverse a deal; the rule is
 * `.superRefine()` on the parent object (zod v4 cross-field pattern, matching
 * BookingApprovalDialog) so the issue attaches to `reason` and the form can
 * highlight that control. Never throw inside a refinement.
 *
 * `reasonRequired` mirrors `TransitionReasonRequired` from @shadhil/api-types -
 * one definition shared by DTO, service guard and this form.
 */
const transitionSchemaFor = (totalAmount: number) =>
  z
  .object({
    toStatus: z.enum(['TOKEN', 'APPROVED', 'REJECTED', 'CANCELLED']),
    reason: z
      .string()
      .trim()
      .max(500, 'Reason must be under 500 characters')
      .optional(),
    // T-TOKEN-GATE cap (owner instruction): the token is a part payment, so it
    // cannot exceed the booking's total. The total is not part of this form, so
    // it is threaded in as a factory argument - the client shows the problem
    // before the request, and the service re-checks it authoritatively.
    tokenAmount: TokenAmountSchema.optional(),
  })
  .superRefine((values, ctx) => {
    if (values.toStatus === 'TOKEN' && values.tokenAmount === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenAmount'],
        message:
          'Enter the token amount received before marking the token as received',
      });
    }
    if (
      values.tokenAmount !== undefined &&
      !isTokenWithinTotal(values.tokenAmount, totalAmount)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenAmount'],
        message: TOKEN_EXCEEDS_TOTAL_MESSAGE,
      });
    }
    if (!TransitionReasonRequired.has(values.toStatus)) return;
    if ((values.reason ?? '').trim().length > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `A reason is required when moving a booking to ${labelFor('booking', values.toStatus)}`,
    });
  });

function BookingActions({
  booking,
  canApprove,
  canInitiate,
  orgSlug,
  projectSlug,
}: {
  booking: BookingRow;
  canApprove: boolean;
  canInitiate: boolean;
  orgSlug: string | null;
  projectSlug: string | null;
}) {
  const router = useRouter();
  const updateBooking = useUpdateBooking();
  const [toStatus, setToStatus] = useState<BookingTransitionTarget | null>(null);

  const status = typeof booking.status === 'string' ? booking.status : '';
  const current = isBookingStatus(status) ? status : null;
  const outgoing = current !== null ? LEGAL_NEXT[current] : [];

  // T-BOOK-ROLES: only offer transitions the service will accept, so the UI
  // never shows a button that answers 403.
  //   TOKEN             -> initiate booking  (MANAGER/SALES_EXEC/ADMIN/OWNER)
  //   APPROVED/REJECTED -> manager decision  (MANAGER/ADMIN/OWNER)
  //   CANCELLED         -> any role that can see the booking (no role gate)
  // T-TOKEN-GATE (2026-09-28, owner instruction): "Don't approve booking without
  // token amount". Approving asserts the token was RECEIVED, so it is only
  // meaningful against a recorded amount - and a booking stuck in TOKEN with no
  // amount (the rows the old transition produced) must be fixed before it can be
  // closed, not approved past with the payment permanently unrecorded.
  //
  // Mirrors the service guard. `tokenAmount` arrives as a decimal string, so it is
  // converted before the check; 0 counts as missing, since a zero token is not a
  // received payment.
  const hasTokenAmount =
    typeof booking.tokenAmount === 'string' &&
    booking.tokenAmount.length > 0 &&
    Number.isFinite(Number(booking.tokenAmount)) &&
    Number(booking.tokenAmount) > 0;

  const offered = outgoing.filter((s) => {
    if (s === 'TOKEN') return canInitiate;
    // Blocked until an amount is recorded - the UI must not offer an action the
    // API refuses, and the reason is stated in the card below rather than left as
    // a dead button.
    if (s === 'APPROVED') return canApprove && hasTokenAmount;
    if (s === 'REJECTED') return canApprove;
    return true;
  });

  // The booking total the token must fit inside, resolved BEFORE the form: the
  // resolver is built from it. A non-finite value falls back to 0, which makes the
  // cap reject any token - the safe direction, since a blocked save beats a silent
  // over-payment.
  const bookingTotalRaw = Number(booking.amount);
  const bookingTotal = Number.isFinite(bookingTotalRaw) ? bookingTotalRaw : 0;

  // Single useForm instance for the card (the props-API Form does not create
  // its own). `toStatus` is mirrored into the form so the resolver can apply
  // the reason rule to the right target.
  const form = useForm<TransitionFormValues>({
    // The token cap needs the booking's total, so the schema is built per
    // booking rather than declared once at module scope.
    resolver: zodResolver(transitionSchemaFor(bookingTotal)),
    defaultValues: { toStatus: 'TOKEN', reason: '', tokenAmount: undefined },
    mode: 'onSubmit',
  });

  // T-TOKEN-GATE: prefill the amount from the booking's own record, so an
  // operator re-confirming a token that was captured at HOLD time (or corrected
  // earlier) cannot silently blank it - which is the state this whole change
  // exists to make impossible.
  const storedTokenNumber = Number(booking.tokenAmount);
  const storedTokenAmount =
    typeof booking.tokenAmount === 'string' &&
    booking.tokenAmount.length > 0 &&
    Number.isFinite(storedTokenNumber) &&
    storedTokenNumber > 0
      ? storedTokenNumber
      : undefined;

  // Confirmation step: the icon for the state being moved INTO, so the confirm
  // button repeats the same visual cue the operator clicked to get here.
  const ConfirmIcon = toStatus !== null ? STATUS_ICONS[toStatus] : undefined;
  const reasonRequired = toStatus !== null && TransitionReasonRequired.has(toStatus);

  // T-TOKEN-GATE: approval is withheld until an amount is recorded, so say so.
  // A control that silently disappears reads as a broken tool; the operator needs
  // to know the booking is fine and the MONEY record is what is missing - and
  // which screen fixes it.
  const approvalBlockedByMissingToken =
    current === 'TOKEN' && canApprove && !hasTokenAmount;
  // `offered` is empty but the booking is not terminal: the only blocker is the
  // missing amount, which deserves its own message rather than "terminal state".
  const nothingOfferedButNotTerminal =
    current !== null && offered.length === 0 && outgoing.length > 0;

  if (current === null || offered.length === 0) {
    return (
      <Card data-qa="booking-actions">
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          {nothingOfferedButNotTerminal ? (
            <div className="space-y-2" data-qa="booking-approval-blocked">
              <div className="text-sm">
                {approvalBlockedByMissingToken
                  ? 'This booking cannot be approved yet: no token amount is recorded.'
                  : 'No actions available for your role.'}
              </div>
              {approvalBlockedByMissingToken ? (
                <p className="text-muted-foreground text-xs">
                  Approving confirms the token was received, so the amount actually
                  received must be on the booking first. Add it with the booking's
                  Edit action, then approve. The booking can still be{' '}
                  {labelFor('booking', 'CANCELLED').toLowerCase()} if the deal fell
                  through.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="text-muted-foreground text-xs">
              {current === null
                ? 'Unknown booking status.'
                : `No actions available from ${labelFor('booking', current)} (terminal state).`}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  function chooseTarget(target: BookingTransitionTarget) {
    // T-TOKEN-GATE: `tokenAmount` starts from what the booking already records
    // (empty when there is none), so the field is prefilled rather than blank.
    form.reset({ toStatus: target, reason: '', tokenAmount: storedTokenAmount });
    setToStatus(target);
  }

  function closeStep() {
    form.reset({ toStatus: 'TOKEN', reason: '', tokenAmount: undefined });
    setToStatus(null);
  }

  function onValid(values: TransitionFormValues) {
    const target = values.toStatus;
    // The resolver guaranteed a reason when one is required; `toStatus` is the
    // form's own value, so the payload can never drift from what was validated.
    const reason = (values.reason ?? '').trim();
    const body: { toStatus: BookingStatus; reason?: string; tokenAmount?: number } = {
      toStatus: target,
    };
    if (reason.length > 0) body.reason = reason;
    // T-TOKEN-GATE: the amount the resolver already validated travels WITH the
    // status change, in the same request - so "token received" and "how much"
    // are recorded together and cannot diverge. It is already a number: the form
    // field writes `valueAsNumber`, and the schema has proven it positive.
    if (target === 'TOKEN' && values.tokenAmount !== undefined) {
      body.tokenAmount = values.tokenAmount;
    }

    updateBooking.mutate(
      { id: booking.id, body },
      {
        onSuccess: () => {
          toast.success(`Booking moved to ${labelFor('booking', target)}`);
          closeStep();
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
          <div className="space-y-3">
            {/* T-TOKEN-GATE: the Approve button is withheld while no token amount
                is recorded. A control that simply vanishes reads as a broken
                tool, so the reason and the fix are stated in the normal view -
                not only in the all-blocked branch, which never fires here
                because Reject and Cancel stay available. */}
            {approvalBlockedByMissingToken && offered.length > 0 ? (
              <p
                className="text-muted-foreground text-xs"
                data-qa="booking-approval-blocked"
              >
                Approval is unavailable: no token amount is recorded, and approving
                confirms the token was received. Add the amount actually received
                with the booking&rsquo;s Edit action, then approve.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {offered.map((target) => {
                const Icon = STATUS_ICONS[target];
                const isApprove = target === 'APPROVED';
                return (
                  <Button
                    key={target}
                    type="button"
                    size="sm"
                    variant={isApprove ? 'default' : 'outline'}
                    onClick={() => chooseTarget(target)}
                    data-qa={`booking-to-${target}`}
                    className="gap-1.5"
                  >
                    {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                    {isApprove ? 'Approve' : labelFor('booking', target)}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : (
          <BookingTransitionConfirmStep
            form={form}
            onSubmit={onValid}
            currentStatus={status}
            toStatus={toStatus}
            reasonRequired={reasonRequired}
            tokenAmountRequired={toStatus === 'TOKEN'}
            isPending={updateBooking.isPending}
            ConfirmIcon={ConfirmIcon}
            onCancelStep={closeStep}
          />
        )}


        <div className="border-border border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void router.push(projectHref(orgSlug, projectSlug, '/bookings'))}
            className="gap-1.5"
          >
            <BACK_ICON className="h-4 w-4" aria-hidden="true" />
            Back to bookings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

